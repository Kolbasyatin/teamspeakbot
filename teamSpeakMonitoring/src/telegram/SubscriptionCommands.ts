import type {Bot, Context, InlineKeyboard} from "grammy";
import type {BotCommand, Chat} from "grammy/types";
import type {CatalogServer} from "../catalog/CatalogServer.js";
import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";
import type {ServerPollResult} from "../monitoring/ServerQuery.js";
import type {BotCommands} from "./TelegramBot.js";
import type {TelegramChat} from "./TelegramChat.js";
import {renderServerCheck, renderServerStatus, STATUS_REFRESH} from "./ServerStatusMessage.js";
import {
    CARD_ACTION_PATTERN,
    decodeCardAction,
    renderServerCard,
    type CardAction,
    type CardActionType,
} from "./ServerCardMessage.js";
import type {SubscriptionEventKind} from "./SubscriptionEvent.js";
import {
    decodeAction,
    LIST_ACTION_PATTERN,
    PAGE_SIZE,
    pageCount,
    renderServerList,
    sanitizeSearch,
    type ListAction,
    type ListActionType,
    type ListOrigin,
    type ListView,
    type ServerListPage,
} from "./ServerListMessage.js";
import {log} from "../logger.js";

//Каталог глазами бота: три вопроса, а не весь репозиторий. Интерфейс объявлен здесь, у потребителя,
//как StatusSource и OnlineNicknamesSource в TelegramBot.
export interface ServerCatalog {
    findCatalogPage(search: string, limit: number, offset: number): Promise<CatalogServer[]>;

    countCatalog(search: string): Promise<number>;

    findByIds(ids: readonly number[]): Promise<CatalogServer[]>;
}

export interface SubscriptionStore {
    saveChat(chat: TelegramChat): Promise<void>;

    subscribe(chatId: number, serverId: number): Promise<void>;

    unsubscribe(chatId: number, serverId: number): Promise<void>;

    findSubscribedServerIds(chatId: number): Promise<number[]>;

    findSubscriptionEvents(chatId: number, serverId: number): Promise<SubscriptionEventKind[]>;

    enableEvent(chatId: number, serverId: number, kind: SubscriptionEventKind): Promise<void>;

    disableEvent(chatId: number, serverId: number, kind: SubscriptionEventKind): Promise<void>;
}

//Текущее состояние опрашиваемых серверов: боту нужен только снимок, весь ServerMonitor
//ему знать незачем.
export interface StatusSource {
    getSnapshot(): ServerProbeSnapshot[];

    //Разовый опрос сервера из каталога, подписка не нужна. undefined — проверять нечего:
    //сервера нет, он скрыт или у него нет включённых источников. Откуда берётся конфиг
    //и чем опрашивается, знает composition root.
    checkServer(serverId: number): Promise<ServerPollResult | undefined>;
}

const START_TEXT = [
    "Слежу за игровыми серверами и пишу, когда они падают и поднимаются.",
    "",
    "/serverlist — каталог серверов, выбрать за какими следить",
    "/serverlist arma — то же самое с поиском по названию",
    "/my — мои подписки и настройка уведомлений по каждому серверу",
    "/status — что сейчас с моими серверами",
    "/time — то же самое",
].join("\n");

//Команды подписок. Отдельно от TelegramBot намеренно: тот показывает состояние (/time, /who),
//этот меняет данные и требует совсем других зависимостей. Один Bot на двоих — регистрируют
//обработчики оба, как и раньше.
//
//Всё работает от chat.id, а не от пользователя: в группе подписка принадлежит ГРУППЕ, и любой
//её участник управляет общим списком. В личке chat.id совпадает с user.id, поэтому там список
//получается персональным сам собой. Кто именно нажал, Telegram сообщает, но мы этого не храним —
//колонки нет, потому что нет потребителя.
export class SubscriptionCommands implements BotCommands {
    constructor(
        private readonly catalog: ServerCatalog,
        private readonly subscriptions: SubscriptionStore,
        private readonly status: StatusSource,
        //Подписка меняет список опроса, поэтому монитор надо пересобрать. Что именно это значит,
        //знает composition root — здесь только факт «подписки изменились».
        private readonly onSubscriptionsChanged: () => void,
    ) {
    }

    //Что делать по каждому действию списка. Record, а не if: добавишь действие — сборка упадёт,
    //пока ему не напишут обработчик. Действий у списка два: листать и открыть карточку;
    //всё содержательное (подписка, проверка, настройки) происходит в карточке.
    //Карточке передаётся само действие: в нём уже лежат список, страница и поиск — то, куда
    //потом возвращаться.
    private readonly listActions: Record<ListActionType, (ctx: Context, action: ListAction) => Promise<void>> = {
        page: (ctx, action) => this.showList(ctx, action),
        open: (ctx, action) => this.showCard(ctx, action.serverId, action),
    };

    //Что делать по каждому действию карточки. Отдельная таблица, потому что и набор действий свой.
    //После подписки и отписки карточка перерисовывается, а не уводит в список: человек видит,
    //что изменилось (появились галочки или кнопка «Подписаться»), и сам решает, куда дальше.
    private readonly cardActions: Record<CardActionType, (ctx: Context, action: CardAction) => Promise<void>> = {
        toggleEvent: async (ctx, action) => {
            if (action.kind) {
                await this.toggleEvent(ctx.chatId ?? 0, action.serverId, action.kind);
            }
            await this.showCard(ctx, action.serverId, action.origin);
        },
        subscribe: async (ctx, action) => {
            await this.subscriptions.subscribe(ctx.chatId ?? 0, action.serverId);
            //Подписались на сервер, который никто не опрашивал, — он должен появиться в опросе
            //сразу, а не после ручного reload.
            this.onSubscriptionsChanged();
            await this.showCard(ctx, action.serverId, action.origin);
        },
        unsubscribe: async (ctx, action) => {
            await this.subscriptions.unsubscribe(ctx.chatId ?? 0, action.serverId);
            //Отписался последний — сервер должен исчезнуть из опроса.
            this.onSubscriptionsChanged();
            await this.showCard(ctx, action.serverId, action.origin);
        },
        check: (ctx, action) => this.checkServer(ctx, action.serverId),
        back: (ctx, action) => this.showList(ctx, toPageAction(action.origin)),
    };

    //`/time` в меню нет намеренно: он синоним `/status`, и показывать одно и то же двумя строками
    //значит запутать. Работать при этом продолжает — старые сообщения и привычка никуда не делись.
    public describe(): BotCommand[] {
        return [
            {command: "serverlist", description: "каталог серверов"},
            {command: "my", description: "мои подписки и настройки уведомлений"},
            {command: "status", description: "что сейчас с моими серверами"},
            {command: "start", description: "что умеет бот"},
        ];
    }

    public register(bot: Bot): void {
        bot.command("start", async ctx => {
            await this.rememberChat(ctx);
            await ctx.reply(START_TEXT);
        });

        bot.command("serverlist", async ctx => {
            await this.rememberChat(ctx);
            await this.replyWithList(ctx, "catalog", 0, sanitizeSearch(ctx.match));
        });

        bot.command("my", async ctx => {
            await this.rememberChat(ctx);
            await this.replyWithList(ctx, "mine", 0, "");
        });

        ///time — синоним /status: раньше он показывал ВСЕ опрашиваемые серверы, а после перехода
        //на подписки это объединение чужих списков, то есть любой видел, за чем следят остальные.
        bot.command(["status", "time"], async ctx => {
            await this.rememberChat(ctx);

            const {text, keyboard} = await this.renderStatus(ctx.chatId ?? 0);

            await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});
        });

        //Кнопки разводятся маршрутизацией grammy, а не цепочкой if внутри одного обработчика:
        //новая кнопка — новая строка регистрации, а не новая ветка. Порядок значим — последний
        //обработчик ловит всё, что не подошло предыдущим.
        bot.callbackQuery(STATUS_REFRESH, ctx => this.refreshStatus(ctx));
        bot.callbackQuery(LIST_ACTION_PATTERN, ctx => this.applyListAction(ctx));
        bot.callbackQuery(CARD_ACTION_PATTERN, ctx => this.applyCardAction(ctx));
        bot.on("callback_query:data", ctx => this.answerOutdated(ctx));
    }

    private async refreshStatus(ctx: Context): Promise<void> {
        await this.rememberChat(ctx);
        await ctx.answerCallbackQuery();

        const {text, keyboard} = await this.renderStatus(ctx.chatId ?? 0);

        //Правим то же сообщение по его id — он приезжает в контексте нажатия.
        //Ошибку глушим: при неизменившемся тексте Telegram отвечает отказом.
        await ctx.editMessageText(text, {parse_mode: "HTML", reply_markup: keyboard})
            .catch((error: unknown) => {
                log.debug({error}, "Не удалось обновить сообщение статуса");
            });
    }

    private async applyListAction(ctx: Context): Promise<void> {
        const action = decodeAction(ctx.callbackQuery?.data ?? "");

        //Начало данных подошло под шаблон, а целиком строка не разобралась: формат сменился
        //между отправкой сообщения и нажатием.
        if (!action) {
            await this.answerOutdated(ctx);
            return;
        }

        await this.rememberChat(ctx);
        //Нажатие подтверждается ДО работы: она ходит в БД и в Telegram, и всё это время
        //на кнопке висел бы индикатор загрузки.
        await ctx.answerCallbackQuery();
        await this.listActions[action.action](ctx, action);
    }

    private async applyCardAction(ctx: Context): Promise<void> {
        const action = decodeCardAction(ctx.callbackQuery?.data ?? "");

        if (!action) {
            await this.answerOutdated(ctx);
            return;
        }

        await this.rememberChat(ctx);
        await ctx.answerCallbackQuery();
        await this.cardActions[action.action](ctx, action);
    }

    private async showList(ctx: Context, action: ListAction): Promise<void> {
        const page = await this.loadPage(ctx.chatId ?? 0, action.view, action.page, action.search);
        const {text, keyboard} = renderServerList(page);

        //Правим то же сообщение, а не шлём новое: список — это табло, а не переписка.
        //Ошибку глушим: Telegram отвечает отказом, если текст и клавиатура не изменились,
        //а такое бывает при двойном нажатии на одну и ту же кнопку.
        await ctx.editMessageText(text, {reply_markup: keyboard}).catch((error: unknown) => {
            log.debug({error}, "Не удалось обновить сообщение со списком серверов");
        });
    }

    private async showCard(ctx: Context, serverId: number, origin: ListOrigin): Promise<void> {
        const chatId = ctx.chatId ?? 0;
        const [server] = await this.catalog.findByIds([serverId]);

        //Сервер могли удалить из каталога, пока человек смотрел на список. Возвращаем туда, откуда пришли.
        if (!server) {
            await this.showList(ctx, toPageAction(origin));
            return;
        }

        const subscribed = (await this.subscriptions.findSubscribedServerIds(chatId)).includes(serverId);
        const enabled = new Set(await this.subscriptions.findSubscriptionEvents(chatId, serverId));
        const {text, keyboard} = renderServerCard(server, subscribed, enabled, origin);

        await ctx.editMessageText(text, {parse_mode: "HTML", reply_markup: keyboard})
            .catch((error: unknown) => {
                log.debug({error}, "Не удалось показать карточку сервера");
            });
    }

    //Разовая проверка — ответ НОВЫМ сообщением, а не правкой карточки: карточка — табло, а это ответ
    //на вопрос, и ему место в переписке. Пока идёт опрос (до таймаута главного источника плюс
    //grace-окно), человек ничего не видит: нажатие уже подтверждено в applyCardAction.
    private async checkServer(ctx: Context, serverId: number): Promise<void> {
        const [server] = await this.catalog.findByIds([serverId]);
        const result = server ? await this.status.checkServer(serverId) : undefined;

        if (!server || !result) {
            await ctx.reply("Этот сервер сейчас нельзя проверить: его нет в каталоге или его нечем опросить.");
            return;
        }

        await ctx.reply(renderServerCheck(server, result, new Date()), {parse_mode: "HTML"});
    }

    private async toggleEvent(
        chatId: number,
        serverId: number,
        kind: SubscriptionEventKind,
    ): Promise<void> {
        const enabled = new Set(await this.subscriptions.findSubscriptionEvents(chatId, serverId));

        if (enabled.has(kind)) {
            await this.subscriptions.disableEvent(chatId, serverId, kind);
        } else {
            await this.subscriptions.enableEvent(chatId, serverId, kind);
        }
    }

    //Нажали кнопку из сообщения, отправленного до смены формата. Ронять обработчик незачем,
    //но и молчать нельзя: пока бот не подтвердит нажатие через answerCallbackQuery, Telegram
    //держит на кнопке индикатор загрузки — около тридцати секунд, и выглядит это как зависший бот.
    private async answerOutdated(ctx: Context): Promise<void> {
        await ctx.answerCallbackQuery("Кнопка устарела, открой список заново");
    }

    //«Что сейчас с моими серверами». Спросить можно только про подписанное, поэтому особого случая
    //«сервер не отслеживают» здесь нет — есть другой: сервер скрыли из каталога уже ПОСЛЕ подписки,
    //и тогда он подписан, но не опрашивается. Такие показываются отдельно, иначе список молча
    //короче, чем подписки.
    private async renderStatus(chatId: number): Promise<{text: string; keyboard: InlineKeyboard}> {
        const subscribedIds = new Set(await this.subscriptions.findSubscribedServerIds(chatId));
        const snapshots = this.status.getSnapshot().filter(snapshot => subscribedIds.has(snapshot.config.id));

        for (const snapshot of snapshots) {
            subscribedIds.delete(snapshot.config.id);
        }

        //Имена оставшихся — из каталога: снимка у них нет, брать имя неоткуда.
        const unmonitored = await this.catalog.findByIds([...subscribedIds]);

        return renderServerStatus(snapshots, unmonitored, new Date());
    }

    private async replyWithList(ctx: Context, view: ListView, page: number, search: string): Promise<void> {
        const listPage = await this.loadPage(ctx.chatId ?? 0, view, page, search);
        const {text, keyboard} = renderServerList(listPage);

        await ctx.reply(text, {reply_markup: keyboard});
    }

    private async loadPage(
        chatId: number,
        view: ListView,
        page: number,
        search: string,
    ): Promise<ServerListPage> {
        const subscribedIds = await this.subscriptions.findSubscribedServerIds(chatId);
        const subscribed = new Set(subscribedIds);

        if (view === "mine") {
            //Свои подписки режутся на страницы в памяти: их читают одним запросом целиком,
            //потому что список человека — это единицы серверов, а не каталог.
            const all = await this.catalog.findByIds(subscribedIds);
            const safePage = clampPage(page, all.length);

            return {
                view,
                servers: all.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
                subscribed,
                page: safePage,
                total: all.length,
                search: "",
            };
        }

        const total = await this.catalog.countCatalog(search);
        const safePage = clampPage(page, total);

        return {
            view,
            servers: await this.catalog.findCatalogPage(search, PAGE_SIZE, safePage * PAGE_SIZE),
            subscribed,
            page: safePage,
            total,
            search,
        };
    }

    //Чат обязан существовать в БД раньше подписки — на него смотрит внешний ключ. Upsert на каждую
    //команду, а не только на /start: бота могли добавить в группу и сразу нажать кнопку, а ещё
    //так подхватывается переименование группы.
    private async rememberChat(ctx: Context): Promise<void> {
        if (!ctx.chat) {
            return;
        }

        await this.subscriptions.saveChat(toTelegramChat(ctx.chat));
    }
}

//«Показать вот этот список на вот этой странице» как действие списка. Так карточка возвращается
//туда, откуда открыта, тем же путём, каким листаются страницы.
function toPageAction(origin: ListOrigin): ListAction {
    return {...origin, action: "page", serverId: 0};
}

//Страница могла исчезнуть, пока человек на неё смотрел: отписался от последнего сервера на ней —
//и её больше нет. Возвращаем на последнюю существующую вместо пустого экрана.
function clampPage(page: number, total: number): number {
    return Math.min(page, pageCount(total) - 1);
}

function toTelegramChat(chat: Chat): TelegramChat {
    return {
        chatId: chat.id,
        type: chat.type,
        //У группы и канала есть название, у лички — только имя человека. Поле нужно тому, кто будет
        //смотреть в таблицу и понимать, кто это; логика на него не завязана.
        title: "title" in chat ? chat.title : chat.username ?? chat.first_name,
    };
}
