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
    PLAYER_CARD_PATTERN,
    PLAYER_HISTORY_PATTERN,
    PLAYER_INFO_PATTERN,
    PLAYER_PICK_PATTERN,
    PLAYER_WAIT_PATTERN,
    decodePlayerCard,
    decodePlayerHistory,
    decodePlayerInfo,
    decodePlayerPick,
    decodePlayerWait,
    renderAliases,
    renderDossier,
    renderMatchNote,
    renderPlayerCard,
    renderSearchResults,
    renderSessions,
    renderSubscriptions,
    type PickerIntent,
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
    "/wait &lt;ник&gt; — ждать игрока, которого мы ещё не видели",
    "/unwatch &lt;ник или id&gt; — отписаться",
    "/players — мои подписки и где они сейчас",
    "/where &lt;ник&gt; — где игрок прямо сейчас",
    "/history &lt;ник&gt; — последние визиты игрока",
    "/aliases &lt;ник&gt; — все ники игрока, по любому из них",
    "/playerinfo &lt;ник&gt; — досье: Steam, налёт в Reforger, друзья",
    "/steaminfo &lt;SteamID64&gt; — досье по Steam-аккаунту, даже если в Arma его не было",
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

        //Ждать ник, которого среди известных нет. Отдельной командой, а не только кнопкой:
        //ник длиннее 64 байт в callback_data не помещается, и кнопки для него не будет.
        bot.command("wait", async ctx => {
            await this.rememberChat(ctx);
            await this.wait(ctx, argumentOf(ctx));
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

        //Все ники игрока по любому из них. Отдельная команда, а не часть карточки: искать человека
        //по полузабытому старому нику — самостоятельная задача, и ответ на неё нужен целиком,
        //а не в виде «выберите одного из восьми».
        bot.command("aliases", async ctx => {
            await this.rememberChat(ctx);
            await this.aliases(ctx, argumentOf(ctx));
        });

        //Досье Steam. Обращение к нему на стороне наблюдателя заодно ставит игрока
        //на регулярное обновление данных — отдельной команды «начни собирать» не нужно.
        bot.command("playerinfo", async ctx => {
            await this.rememberChat(ctx);
            await this.playerInfo(ctx, argumentOf(ctx));
        });

        //Досье по SteamID64 напрямую. Игрока в Arma может не быть вовсе: Steam про нашу игру
        //ничего не знает, и связь с наблюдаемыми серверами здесь не нужна.
        bot.command("steaminfo", async ctx => {
            await this.rememberChat(ctx);
            await this.steamInfo(ctx, argumentOf(ctx));
        });

        bot.command("observed", async ctx => {
            await this.rememberChat(ctx);
            await this.showObservedServers(ctx);
        });

        //Кнопка выбора игрока из результатов поиска. Регистрируется здесь же, до общего
        //обработчика «кнопка устарела» из SubscriptionCommands: порядок регистрации в grammy значим.
        bot.callbackQuery(PLAYER_PICK_PATTERN, ctx => this.pickPlayer(ctx));
        bot.callbackQuery(PLAYER_WAIT_PATTERN, ctx => this.waitByButton(ctx));
        bot.callbackQuery(PLAYER_INFO_PATTERN, ctx => this.dossierByButton(ctx));
        //Кнопки выбора для команд, которые ничего не меняют.
        bot.callbackQuery(PLAYER_CARD_PATTERN, ctx => this.cardByButton(ctx));
        bot.callbackQuery(PLAYER_HISTORY_PATTERN, ctx => this.historyByButton(ctx));
    }

    public describe(): BotCommand[] {
        return [
            {command: "watch", description: "следить за игроком"},
            {command: "wait", description: "ждать игрока, которого мы ещё не видели"},
            {command: "unwatch", description: "перестать следить за игроком"},
            {command: "players", description: "мои игроки и где они сейчас"},
            {command: "where", description: "где игрок сейчас"},
            {command: "history", description: "последние визиты игрока"},
            {command: "aliases", description: "все ники игрока"},
            {command: "playerinfo", description: "досье игрока: Steam, налёт, друзья"},
            {command: "steaminfo", description: "досье по SteamID64"},
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

        const {text, keyboard} = renderSearchResults(
            found.players, found.fuzzy, this.now(), argument, "watch", await this.subscribedIds(ctx));

        await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});
    }

    //Человек сам называет ник, которого мы не видели. Поиск здесь не делается: он уже был сделан
    //(иначе откуда бы взялась кнопка), а «ждать» — осознанное решение, а не догадка.
    private async wait(ctx: Context, nickname: string): Promise<void> {
        if (nickname === "") {
            await ctx.reply("Какой ник ждать? /wait &lt;ник&gt;", {parse_mode: "HTML"});
            return;
        }

        await this.offerPending(ctx, ctx.chatId ?? 0, nickname);
    }

    private async waitByButton(ctx: Context): Promise<void> {
        const nickname = decodePlayerWait(ctx.callbackQuery?.data ?? "");

        if (nickname === undefined) {
            await ctx.answerCallbackQuery("Кнопка устарела");
            return;
        }

        await this.rememberChat(ctx);
        //Нажатие подтверждается ДО работы: она ходит в БД, и всё это время на кнопке
        //висел бы индикатор загрузки.
        await ctx.answerCallbackQuery();
        await this.offerPending(ctx, ctx.chatId ?? 0, nickname);
    }

    private async unwatch(ctx: Context, argument: string): Promise<void> {
        const chatId = ctx.chatId ?? 0;

        if (argument === "") {
            await ctx.reply("Кого перестать отслеживать? /unwatch &lt;ник или id&gt;", {parse_mode: "HTML"});
            return;
        }

        //Ожидание снимается по нику без похода в чужой сервис: игрока за ним ещё нет.
        //Сравнение регистронезависимое, а удаляется ИМЕННО СОХРАНЁННОЕ написание, а не введённое:
        //коллация MariaDB (utf8mb4_unicode_ci) и так игнорирует регистр, но полагаться на неё
        //молча нельзя — сменится коллация, и «/unwatch salat» перестанет снимать «Salat».
        const pending = await this.subscriptions.findPendingByChat(chatId);
        const stored = pending.find(nickname => nickname.toLowerCase() === argument.toLowerCase());

        if (stored !== undefined) {
            await this.subscriptions.removePending(chatId, stored);
            await ctx.reply(`Больше не жду игрока «${stored}».`);
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
            const empty = renderSubscriptions([], pending, this.now());

            await ctx.reply(empty.text, {parse_mode: "HTML", reply_markup: empty.keyboard});
            return;
        }

        const players = await this.withObserver(ctx, () => this.observer.playersByIds(ids));

        if (!players) {
            return;
        }

        const {text, keyboard} = renderSubscriptions(players, pending, this.now());

        await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});
    }

    private async where(ctx: Context, argument: string): Promise<void> {
        if (argument === "") {
            await ctx.reply("Кого искать? /where &lt;ник&gt;", {parse_mode: "HTML"});
            return;
        }

        const player = await this.resolveOne(ctx, argument, "card");

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

        const player = await this.resolveOne(ctx, argument, "history");

        if (!player) {
            return;
        }

        const sessions = await this.withObserver(ctx, () => this.observer.sessions(player.playerId, SESSIONS_LIMIT));

        if (!sessions) {
            return;
        }

        await ctx.reply(renderSessions(player, sessions, this.now()), {parse_mode: "HTML"});
    }

    //В отличие от остальных команд по нику, здесь НЕ используется resolveOne: он на нескольких
    //совпадениях показывает кнопки «выберите игрока». Для вопроса «а какие ещё ники у этого
    //человека» правильный ответ — показать всех подошедших сразу, вместе с их никами: однофамильцы
    //тогда видны рядом, и по списку ников понятно, кто из них нужен.
    private async aliases(ctx: Context, argument: string): Promise<void> {
        if (argument === "") {
            await ctx.reply("Чьи ники показать? /aliases &lt;ник&gt;", {parse_mode: "HTML"});
            return;
        }

        const found = await this.find(ctx, argument);

        //undefined — наблюдатель недоступен, про это уже ответили. Пустой список — искали, но не нашли:
        //похожие подставляет сам наблюдатель, и если и их нет, предлагать нечего.
        if (!found) {
            return;
        }

        await ctx.reply(renderAliases(found.players, found.fuzzy, argument, this.now()), {parse_mode: "HTML"});
    }

    private async playerInfo(ctx: Context, argument: string): Promise<void> {
        if (argument === "") {
            await ctx.reply("На кого посмотреть? /playerinfo &lt;ник&gt;", {parse_mode: "HTML"});
            return;
        }

        const player = await this.resolveOne(ctx, argument, "info");

        if (!player) {
            return;
        }

        await this.sendDossier(ctx, player);
    }

    //Нажатие «🔎 Досье» из карточки или из списка подписок: id уже известен, искать не нужно.
    private async dossierByButton(ctx: Context): Promise<void> {
        const playerId = decodePlayerInfo(ctx.callbackQuery?.data ?? "");

        if (playerId === undefined) {
            await ctx.answerCallbackQuery("Кнопка устарела");
            return;
        }

        //Отвечаем Telegram сразу: сбор данных у наблюдателя может занять несколько секунд,
        //а нажатая кнопка всё это время крутится.
        await ctx.answerCallbackQuery();
        await this.rememberChat(ctx);

        const player = await this.withObserver(ctx, () => this.observer.player(playerId));

        if (!player) {
            await ctx.reply("Игрок больше не известен наблюдателю.");
            return;
        }

        await this.sendDossier(ctx, player);
    }

    //Выбор из списка тёзок для /where: показываем карточку, ничего не меняя.
    private async cardByButton(ctx: Context): Promise<void> {
        const player = await this.playerFromButton(ctx, decodePlayerCard(ctx.callbackQuery?.data ?? ""));

        if (!player) {
            return;
        }

        const subscribed = (await this.subscriptions.findSubscribedPlayerIds(ctx.chatId ?? 0))
            .includes(player.playerId);
        const {text, keyboard} = renderPlayerCard(player, subscribed, this.now());

        await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});
    }

    //Выбор из списка тёзок для /history.
    private async historyByButton(ctx: Context): Promise<void> {
        const player = await this.playerFromButton(ctx, decodePlayerHistory(ctx.callbackQuery?.data ?? ""));

        if (!player) {
            return;
        }

        const sessions = await this.withObserver(ctx, () => this.observer.sessions(player.playerId, SESSIONS_LIMIT));

        if (!sessions) {
            return;
        }

        await ctx.reply(renderSessions(player, sessions, this.now()), {parse_mode: "HTML"});
    }

    //Общее начало всех кнопок выбора: подтвердить нажатие и достать игрока по id.
    private async playerFromButton(ctx: Context, playerId: number | undefined): Promise<ObservedPlayer | undefined> {
        if (playerId === undefined) {
            await ctx.answerCallbackQuery("Кнопка устарела");
            return undefined;
        }

        //Подтверждаем ДО работы: она ходит в чужой сервис, и всё это время на кнопке
        //крутился бы индикатор загрузки.
        await ctx.answerCallbackQuery();
        await this.rememberChat(ctx);

        const player = await this.withObserver(ctx, () => this.observer.player(playerId));

        if (player === undefined) {
            return undefined;
        }

        if (!player) {
            await ctx.reply("Этого игрока больше нет в наблюдении.");
            return undefined;
        }

        return player;
    }

    private async steamInfo(ctx: Context, argument: string): Promise<void> {
        if (argument === "") {
            await ctx.reply("Чей аккаунт посмотреть? /steaminfo &lt;SteamID64&gt;", {parse_mode: "HTML"});
            return;
        }

        const dossier = await this.withObserver(ctx, () => this.observer.dossierBySteamId(argument));

        if (dossier === undefined) {
            return;
        }

        //null — наблюдатель не принял формат. SteamID64 это ровно 17 цифр; всё остальное
        //(ссылка на профиль, короткое имя аккаунта) требует отдельного разрешения имени,
        //которого у нас нет.
        if (dossier === null) {
            await ctx.reply("SteamID64 — это 17 цифр, например 76561198884181842.");
            return;
        }

        await ctx.reply(renderDossier(dossier, this.now()), {parse_mode: "HTML"});
    }

    private async sendDossier(ctx: Context, player: ObservedPlayer): Promise<void> {
        const dossier = await this.withObserver(ctx, () => this.observer.dossier(player.playerId));

        if (dossier === undefined) {
            return;
        }

        //null от наблюдателя означает «Steam-аккаунт не наблюдался»: в Reforger играют
        //и с консолей, и это ответ, а не сбой.
        if (dossier === null) {
            await ctx.reply(
                `У «${player.currentNickname}» не видели Steam-аккаунта — возможно, он играет с консоли.`,
            );
            return;
        }

        await ctx.reply(renderDossier(dossier, this.now(), player), {parse_mode: "HTML"});
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
                `Запомнил ник «${nickname}»: напишу, когда такой игрок появится на наблюдаемых серверах.`,
                "",
                `Жду ${days} дн., снять — /unwatch ${nickname}. Мои ожидания видно в /players.`,
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
    //
    //intent обязателен и определяет, что сделает кнопка выбора. Раньше список был один на все
    //команды и его кнопки ПЕРЕКЛЮЧАЛИ ПОДПИСКУ: человек спрашивал «покажи досье Zalex»,
    //выбирал Zalex из двух тёзок и получал «больше не слежу за Zalex».
    private async resolveOne(ctx: Context, argument: string, intent: PickerIntent): Promise<ObservedPlayer | undefined> {
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
            //Совпадение могло прийти по ПРЕЖНЕМУ нику: поиск идёт по всем алиасам. Молча
            //показать карточку с другим именем — значит выглядеть ошибкой: человек спросил
            //про «Zalex», а увидел «Aidaho» без единого слова о том, что это тот же игрок.
            const note = renderMatchNote(single, argument);

            if (note !== undefined) {
                await ctx.reply(note, {parse_mode: "HTML"});
            }

            return single;
        }

        const {text, keyboard} = renderSearchResults(
            found.players, found.fuzzy, this.now(), argument, intent, await this.subscribedIds(ctx));

        await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});

        return undefined;
    }

    //Подписки чата для пометки в списке выбора. Отдельным методом, потому что нужен двум местам
    //и потому что чат может быть неизвестен — тогда просто никого не помечаем.
    private async subscribedIds(ctx: Context): Promise<Set<number>> {
        return new Set(await this.subscriptions.findSubscribedPlayerIds(ctx.chatId ?? 0));
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

        const {text, keyboard} = renderSearchResults(matched, false, this.now(), "", "watch");

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
