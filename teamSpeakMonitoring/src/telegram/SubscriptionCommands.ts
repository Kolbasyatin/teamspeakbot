import type {Bot, Context} from "grammy";
import type {BotCommand, Chat} from "grammy/types";
import type {CatalogServer} from "../catalog/CatalogServer.js";
import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";
import type {BotCommands} from "./TelegramBot.js";
import type {TelegramChat} from "./TelegramChat.js";
import {renderServerStatus} from "./ServerStatusMessage.js";
import {
    decodeAction,
    PAGE_SIZE,
    pageCount,
    renderServerList,
    sanitizeSearch,
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
}

//Текущее состояние опрашиваемых серверов: боту нужен только снимок, весь ServerMonitor
//ему знать незачем.
export interface StatusSource {
    getSnapshot(): ServerProbeSnapshot[];
}

const START_TEXT = [
    "Слежу за игровыми серверами и пишу, когда они падают и поднимаются.",
    "",
    "/serverlist — каталог серверов, выбрать за какими следить",
    "/serverlist arma — то же самое с поиском по названию",
    "/my — мои подписки",
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

    //`/time` в меню нет намеренно: он синоним `/status`, и показывать одно и то же двумя строками
    //значит запутать. Работать при этом продолжает — старые сообщения и привычка никуда не делись.
    public describe(): BotCommand[] {
        return [
            {command: "serverlist", description: "каталог серверов"},
            {command: "my", description: "мои подписки"},
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
            await ctx.reply(await this.renderStatus(ctx.chatId ?? 0), {parse_mode: "HTML"});
        });

        bot.on("callback_query:data", async ctx => {
            const action = decodeAction(ctx.callbackQuery.data);

            //Нажали кнопку из сообщения, отправленного до смены формата. Ронять обработчик незачем,
            //но и молчать нельзя: у человека крутится часик на кнопке.
            if (!action) {
                await ctx.answerCallbackQuery("Кнопка устарела, открой список заново");
                return;
            }

            await this.rememberChat(ctx);

            if (action.action === "toggle") {
                await this.toggleSubscription(ctx.chatId ?? 0, action.serverId);
            }

            //Часик на кнопке гасится ДО перерисовки: она ходит в БД и в Telegram, и всё это время
            //кнопка выглядела бы зависшей.
            await ctx.answerCallbackQuery();

            const page = await this.loadPage(ctx.chatId ?? 0, action.view, action.page, action.search);
            const {text, keyboard} = renderServerList(page);

            //Правим то же сообщение, а не шлём новое: список — это табло, а не переписка.
            //Ошибку глушим: Telegram отвечает отказом, если текст и клавиатура не изменились,
            //а такое бывает при двойном нажатии на одну и ту же кнопку.
            await ctx.editMessageText(text, {reply_markup: keyboard}).catch((error: unknown) => {
                log.debug({error}, "Не удалось обновить сообщение со списком серверов");
            });
        });
    }

    //«Что сейчас с моими серверами». Спросить можно только про подписанное, поэтому особого случая
    //«сервер не отслеживают» здесь нет — есть другой: сервер скрыли из каталога уже ПОСЛЕ подписки,
    //и тогда он подписан, но не опрашивается. Такие показываются отдельно, иначе список молча
    //короче, чем подписки.
    private async renderStatus(chatId: number): Promise<string> {
        const subscribedIds = new Set(await this.subscriptions.findSubscribedServerIds(chatId));
        const snapshots = this.status.getSnapshot().filter(snapshot => subscribedIds.has(snapshot.config.id));

        for (const snapshot of snapshots) {
            subscribedIds.delete(snapshot.config.id);
        }

        //Имена оставшихся — из каталога: снимка у них нет, брать имя неоткуда.
        const unmonitored = await this.catalog.findByIds([...subscribedIds]);

        return renderServerStatus(snapshots, unmonitored, new Date());
    }

    private async toggleSubscription(chatId: number, serverId: number): Promise<void> {
        const subscribed = new Set(await this.subscriptions.findSubscribedServerIds(chatId));

        if (subscribed.has(serverId)) {
            await this.subscriptions.unsubscribe(chatId, serverId);
        } else {
            await this.subscriptions.subscribe(chatId, serverId);
        }

        //Подписались на сервер, который никто не опрашивал, — он должен появиться в опросе сразу,
        //а не после ручного reload. Отписался последний — наоборот, исчезнуть.
        this.onSubscriptionsChanged();
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
