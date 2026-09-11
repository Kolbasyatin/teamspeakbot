import type {Bot, Context} from "grammy";
import type {BotCommand} from "grammy/types";
import type {Logger} from "pino";
import {
    PlayerObserverUnavailable,
    type ObservedPlayer,
    type PlayerObserver,
} from "../players/PlayerObserver.js";
import type {BotCommands} from "./TelegramBot.js";
import type {TelegramChat, TelegramChatType} from "./TelegramChat.js";
import {
    PLAYER_PICK_PATTERN,
    decodePlayerPick,
    renderPlayerCard,
    renderSearchResults,
    renderSessions,
    renderSubscriptions,
} from "./PlayerMessages.js";

//Подписки на игроков глазами бота: ровно то, что нужно командам. Интерфейс объявлен здесь,
//у потребителя, как ServerCatalog и SubscriptionStore в SubscriptionCommands.
export interface PlayerSubscriptionStore {
    subscribe(chatId: number, playerId: number): Promise<void>;

    unsubscribe(chatId: number, playerId: number): Promise<void>;

    findSubscribedPlayerIds(chatId: number): Promise<number[]>;

    addPending(chatId: number, nickname: string, expiresAt: Date): Promise<void>;

    removePending(chatId: number, nickname: string): Promise<void>;

    findPendingByChat(chatId: number): Promise<string[]>;

    countPendingByChat(chatId: number): Promise<number>;
}

//Регистрация чата. Отдельным интерфейсом, а не через PlayerSubscriptionStore: чат принадлежит
//подпискам на серверы (миграция 005), и второй владелец ему не нужен — реализует его тот же
//SubscriptionRepository, что и раньше.
export interface ChatRegistry {
    saveChat(chat: TelegramChat): Promise<void>;
}

export interface PlayerCommandsProperties {
    //Сколько живёт ожидание «появится игрок с таким ником». Без срока оно превращается
    //в вечный источник запросов к соседнему сервису.
    pendingTtlMs: number;
    //Сколько ожиданий разрешено одному чату.
    pendingLimit: number;
}

const SEARCH_LIMIT = 8;
const SESSIONS_LIMIT = 10;
const MIN_NICKNAME_LENGTH = 2;

const HELP_TEXT = [
    "Слежу за игроками на отслеживаемых серверах Arma Reforger.",
    "",
    "/watch &lt;ник&gt; — найти игрока и подписаться на вход и выход",
    "/unwatch &lt;ник или id&gt; — отписаться",
    "/players — мои подписки и где они сейчас",
    "/where &lt;ник&gt; — где игрок прямо сейчас",
    "/history &lt;ник&gt; — последние визиты игрока",
    "/observed — какие серверы наблюдаются",
].join("\n");

//Команды про игроков. Отдельный набор, а не добавка к SubscriptionCommands: те про серверы
//и живут на своих репозиториях, эти ходят в соседний сервис по HTTP. Один Bot на всех —
//регистрируют обработчики оба, как и было задумано интерфейсом BotCommands.
//
//Всё работает от chat.id, как и подписки на серверы: в группе список общий, в личке персональный.
export class PlayerCommands implements BotCommands {
    public constructor(
        private readonly observer: PlayerObserver,
        private readonly subscriptions: PlayerSubscriptionStore,
        private readonly chats: ChatRegistry,
        private readonly properties: PlayerCommandsProperties,
        private readonly logger: Logger,
        private readonly now: () => Date,
    ) {
    }

    public register(bot: Bot): void {
        bot.command("watch", async ctx => {
            await this.rememberChat(ctx);
            await this.watch(ctx, argumentOf(ctx));
        });

        bot.command("unwatch", async ctx => {
            await this.rememberChat(ctx);
            await this.unwatch(ctx, argumentOf(ctx));
        });

        bot.command("players", async ctx => {
            await this.rememberChat(ctx);
            await this.showSubscriptions(ctx);
        });

        bot.command("where", async ctx => {
            await this.rememberChat(ctx);
            await this.where(ctx, argumentOf(ctx));
        });

        bot.command("history", async ctx => {
            await this.rememberChat(ctx);
            await this.history(ctx, argumentOf(ctx));
        });

        bot.command("observed", async ctx => {
            await this.rememberChat(ctx);
            await this.showObservedServers(ctx);
        });

        //Кнопка выбора игрока из результатов поиска. Регистрируется здесь же, до общего
        //обработчика «кнопка устарела» из SubscriptionCommands: порядок регистрации в grammy значим.
        bot.callbackQuery(PLAYER_PICK_PATTERN, ctx => this.pickPlayer(ctx));
    }

    public describe(): BotCommand[] {
        return [
            {command: "watch", description: "следить за игроком"},
            {command: "unwatch", description: "перестать следить за игроком"},
            {command: "players", description: "мои игроки и где они сейчас"},
            {command: "where", description: "где игрок сейчас"},
            {command: "history", description: "последние визиты игрока"},
            {command: "observed", description: "какие серверы наблюдаются"},
        ];
    }

    private async watch(ctx: Context, argument: string): Promise<void> {
        if (argument === "") {
            await ctx.reply(HELP_TEXT, {parse_mode: "HTML"});
            return;
        }

        const chatId = ctx.chatId ?? 0;
        const found = await this.find(ctx, argument);

        if (!found) {
            return;
        }

        //Ничего не нашлось — предлагаем запомнить ник. Это единственный честный ответ:
        //отличить опечатку от «играет вне наблюдаемых серверов» мы не можем.
        if (found.players.length === 0) {
            await this.offerPending(ctx, chatId, argument);
            return;
        }

        const [single] = found.players;

        //Один точный кандидат — подписываем сразу. Несколько или похожие — выбирает человек:
        //ники не уникальны, и угадывать за него нельзя.
        if (found.players.length === 1 && single && !found.fuzzy) {
            await this.subscribeAndShow(ctx, chatId, single);
            return;
        }

        const {text, keyboard} = renderSearchResults(found.players, found.fuzzy, this.now(), argument);

        await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});
    }

    private async unwatch(ctx: Context, argument: string): Promise<void> {
        const chatId = ctx.chatId ?? 0;

        if (argument === "") {
            await ctx.reply("Кого перестать отслеживать? /unwatch &lt;ник или id&gt;", {parse_mode: "HTML"});
            return;
        }

        //Ожидание снимается по нику без похода в чужой сервис: игрока за ним ещё нет.
        const pending = await this.subscriptions.findPendingByChat(chatId);

        if (pending.some(nickname => nickname.toLowerCase() === argument.toLowerCase())) {
            await this.subscriptions.removePending(chatId, argument);
            await ctx.reply(`Больше не жду игрока «${argument}».`);
            return;
        }

        const player = await this.resolveSubscribed(ctx, chatId, argument);

        if (!player) {
            return;
        }

        await this.subscriptions.unsubscribe(chatId, player.playerId);
        await ctx.reply(`Больше не слежу за «${player.currentNickname}».`);
    }

    private async showSubscriptions(ctx: Context): Promise<void> {
        const chatId = ctx.chatId ?? 0;
        const ids = await this.subscriptions.findSubscribedPlayerIds(chatId);
        const pending = await this.subscriptions.findPendingByChat(chatId);

        if (ids.length === 0) {
            await ctx.reply(renderSubscriptions([], pending, this.now()), {parse_mode: "HTML"});
            return;
        }

        const players = await this.withObserver(ctx, () => this.observer.playersByIds(ids));

        if (!players) {
            return;
        }

        await ctx.reply(renderSubscriptions(players, pending, this.now()), {parse_mode: "HTML"});
    }

    private async where(ctx: Context, argument: string): Promise<void> {
        if (argument === "") {
            await ctx.reply("Кого искать? /where &lt;ник&gt;", {parse_mode: "HTML"});
            return;
        }

        const player = await this.resolveOne(ctx, argument);

        if (!player) {
            return;
        }

        const subscribed = (await this.subscriptions.findSubscribedPlayerIds(ctx.chatId ?? 0))
            .includes(player.playerId);
        const {text, keyboard} = renderPlayerCard(player, subscribed, this.now());

        await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});
    }

    private async history(ctx: Context, argument: string): Promise<void> {
        if (argument === "") {
            await ctx.reply("Чью историю показать? /history &lt;ник&gt;", {parse_mode: "HTML"});
            return;
        }

        const player = await this.resolveOne(ctx, argument);

        if (!player) {
            return;
        }

        const sessions = await this.withObserver(ctx, () => this.observer.sessions(player.playerId, SESSIONS_LIMIT));

        if (!sessions) {
            return;
        }

        await ctx.reply(renderSessions(player, sessions, this.now()), {parse_mode: "HTML"});
    }

    private async showObservedServers(ctx: Context): Promise<void> {
        const servers = await this.withObserver(ctx, () => this.observer.trackedServers());

        if (!servers) {
            return;
        }

        if (servers.length === 0) {
            await ctx.reply("Сейчас не наблюдается ни один сервер.");
            return;
        }

        const lines = [`Наблюдается серверов: ${servers.length}. Игроки видны только на них.`, ""];

        //Показываем десять самых населённых: полный список из сотни строк никто не читает.
        for (const server of servers.slice(0, 10)) {
            const players = server.players === undefined ? "?" : String(server.players);
            const limit = server.playerLimit === undefined ? "?" : String(server.playerLimit);
            const queue = server.queue !== undefined && server.queue > 0 ? `, очередь ${server.queue}` : "";

            lines.push(`• ${server.name} — ${players}/${limit}${queue}`);
        }

        await ctx.reply(lines.join("\n"));
    }

    //Нажали кнопку выбора игрока. Кнопка одна и переключающая: подписан — отписываемся, нет —
    //подписываемся. Так одна и та же карточка работает и как результат поиска, и как /where.
    private async pickPlayer(ctx: Context): Promise<void> {
        const playerId = decodePlayerPick(ctx.callbackQuery?.data ?? "");

        if (playerId === undefined) {
            await ctx.answerCallbackQuery("Кнопка устарела");
            return;
        }

        await this.rememberChat(ctx);
        //Нажатие подтверждается ДО работы: она ходит в БД и в чужой сервис, и всё это время
        //на кнопке висел бы индикатор загрузки.
        await ctx.answerCallbackQuery();

        const chatId = ctx.chatId ?? 0;
        const player = await this.withObserver(ctx, () => this.observer.player(playerId));

        if (player === undefined) {
            return;
        }

        if (!player) {
            await ctx.reply("Этого игрока больше нет в наблюдении.");
            return;
        }

        const subscribed = (await this.subscriptions.findSubscribedPlayerIds(chatId)).includes(playerId);

        if (subscribed) {
            await this.subscriptions.unsubscribe(chatId, playerId);
            await ctx.reply(`Больше не слежу за «${player.currentNickname}».`);
            return;
        }

        await this.subscribeAndShow(ctx, chatId, player);
    }

    private async subscribeAndShow(ctx: Context, chatId: number, player: ObservedPlayer): Promise<void> {
        await this.subscriptions.subscribe(chatId, player.playerId);

        const {text} = renderPlayerCard(player, true, this.now());

        await ctx.reply(`Слежу за игроком.\n\n${text}`, {parse_mode: "HTML"});
    }

    //Ничего не нашлось: предлагаем запомнить ник. Лимит — чтобы один чат не превратил
    //резолвер в бесконечный поток запросов к соседу.
    private async offerPending(ctx: Context, chatId: number, nickname: string): Promise<void> {
        const pendingCount = await this.subscriptions.countPendingByChat(chatId);

        if (pendingCount >= this.properties.pendingLimit) {
            await ctx.reply(
                `Такого игрока мы не видели, а список ожидания уже полон (${this.properties.pendingLimit}). `
                + "Снимите лишнее через /unwatch.",
            );
            return;
        }

        const expiresAt = new Date(this.now().getTime() + this.properties.pendingTtlMs);
        const days = Math.round(this.properties.pendingTtlMs / 86_400_000);

        await this.subscriptions.addPending(chatId, nickname, expiresAt);
        await ctx.reply(
            [
                `Игрока «${nickname}» мы не видели.`,
                "Он мог играть только на серверах вне наблюдения (/observed) — или в нике опечатка.",
                "",
                `Запомнил ник: напишу, когда он появится. Жду ${days} дн., снять — /unwatch ${nickname}.`,
            ].join("\n"),
        );
    }

    //Поиск с общей обработкой отказа соседа: команды не должны падать из-за него.
    private async find(ctx: Context, nickname: string): Promise<{players: ObservedPlayer[]; fuzzy: boolean} | undefined> {
        if (nickname.length < MIN_NICKNAME_LENGTH && !isNumeric(nickname)) {
            await ctx.reply("Ник для поиска — минимум два символа.");
            return undefined;
        }

        //Чистое число — это id игрока из наших же сообщений, а не ник: искать по нему бессмысленно.
        if (isNumeric(nickname)) {
            const player = await this.withObserver(ctx, () => this.observer.player(Number(nickname)));

            if (player === undefined) {
                return undefined;
            }

            return {players: player ? [player] : [], fuzzy: false};
        }

        return this.withObserver(ctx, () => this.observer.searchPlayers(nickname, SEARCH_LIMIT));
    }

    //Один игрок для команд, которым выбор не нужен: берём единственного, иначе показываем список.
    private async resolveOne(ctx: Context, argument: string): Promise<ObservedPlayer | undefined> {
        const found = await this.find(ctx, argument);

        if (!found) {
            return undefined;
        }

        if (found.players.length === 0) {
            await ctx.reply(
                `Игрока «${argument}» мы не видели. Возможно, он играет на серверах вне наблюдения — /observed.`,
            );
            return undefined;
        }

        const [single] = found.players;

        if (found.players.length === 1 && single && !found.fuzzy) {
            return single;
        }

        const {text, keyboard} = renderSearchResults(found.players, found.fuzzy, this.now(), argument);

        await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});

        return undefined;
    }

    //Игрок среди подписок чата: для /unwatch по нику. Ищем среди своих, а не по всему каталогу,
    //иначе «отписаться от Salat» сняло бы подписку на однофамильца.
    private async resolveSubscribed(ctx: Context, chatId: number, argument: string): Promise<ObservedPlayer | undefined> {
        const ids = await this.subscriptions.findSubscribedPlayerIds(chatId);

        if (ids.length === 0) {
            await ctx.reply("Вы ни за кем не следите.");
            return undefined;
        }

        const players = await this.withObserver(ctx, () => this.observer.playersByIds(ids));

        if (!players) {
            return undefined;
        }

        const wanted = argument.toLowerCase();
        const matched = players.filter(player =>
            String(player.playerId) === argument
            || player.currentNickname.toLowerCase() === wanted
            || player.aliases.some(alias => alias.toLowerCase() === wanted));

        const [single] = matched;

        if (matched.length === 1 && single) {
            return single;
        }

        if (matched.length === 0) {
            await ctx.reply(`Среди ваших подписок нет «${argument}». Посмотреть список — /players.`);
            return undefined;
        }

        const {text, keyboard} = renderSearchResults(matched, false, this.now());

        await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});

        return undefined;
    }

    //Общая обёртка над походом к соседу: недоступность превращается в человеческий ответ,
    //а не в отказ обработчика. Возвращает undefined, когда уже ответила сама.
    private async withObserver<T>(ctx: Context, action: () => Promise<T>): Promise<T | undefined> {
        try {
            return await action();
        } catch (error) {
            if (error instanceof PlayerObserverUnavailable) {
                this.logger.warn({error: error.message}, "Наблюдатель за игроками недоступен");
                await ctx.reply("Сервис наблюдения за игроками сейчас недоступен, попробуйте позже.");
                return undefined;
            }

            throw error;
        }
    }

    private async rememberChat(ctx: Context): Promise<void> {
        const chat = ctx.chat;

        if (!chat) {
            return;
        }

        await this.chats.saveChat({
            chatId: chat.id,
            type: chat.type as TelegramChatType,
            title: "title" in chat ? chat.title : undefined,
        });
    }
}

//Аргумент команды: всё после «/watch». grammy кладёт его в ctx.match, но там строка с пробелами
//по краям и без гарантии типа.
function argumentOf(ctx: Context): string {
    const match = ctx.match;

    return typeof match === "string" ? match.trim() : "";
}

function isNumeric(value: string): boolean {
    return /^\d+$/.test(value);
}
