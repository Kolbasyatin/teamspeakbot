//Контракт наблюдателя за игроками (сервис armaplayers, репозиторий arma-players-backend) глазами бота.
//Объявлен здесь, у потребителя, как Querier в monitoring/ServerQuery.ts: команды и рассылка работают
//с этими типами, а как они приезжают по HTTP — забота адаптера PlayerObserverClient.
//
//Своих доменных сущностей у бота тут нет: игроки, серверы и события принадлежат чужому сервису,
//мы их только показываем. Поэтому типы описывают ЕГО ответы, а не нашу модель.

//Что случилось с игроком. Строки приходят из чужого API, поэтому неизвестное значение — не ошибка:
//сервис может завести новый тип раньше, чем бот научится его показывать.
export type PlayerEventType =
    | "PLAYER_JOINED_SERVER"
    | "PLAYER_LEFT_SERVER"
    | "PLAYER_ENTERED_QUEUE"
    | "PLAYER_LEFT_QUEUE"
    | "PLAYER_NICKNAME_CHANGED";

export interface PlayerEvent {
    id: number;
    type: PlayerEventType | string;
    occurredAt: Date;
    playerId: number;
    //Ник на момент события, а не текущий: человек подписывался на одного, а событие описывает
    //то, что уже произошло.
    nickname: string;
    serverId: number | undefined;
    serverName: string;
    //Для событий выхода — сколько длился визит или ожидание в очереди.
    durationSeconds: number | undefined;
    //Детали события: старый и новый ник, результат ожидания в очереди.
    payload: Record<string, unknown>;
    //Вход замечен после разрыва в наблюдении: момент неточен, мог случиться раньше.
    afterDataGap: boolean;
}

export interface PlayerEventsPage {
    events: PlayerEvent[];
    //Курсор для следующего запроса. Равен переданному, если новых событий не было.
    nextAfter: number;
}

export interface ObservedServer {
    id: number;
    name: string;
    hostAddress: string;
    tracked: boolean;
    players: number | undefined;
    playerLimit: number | undefined;
    queue: number | undefined;
}

//Где игрок сейчас или где был в последний раз.
export interface PlayerLocation {
    serverId: number;
    serverName: string;
    //Только для «сейчас»: с какого момента игрок на сервере.
    since: Date | undefined;
}

export interface PlayerPlatform {
    type: string;
    id: string;
}

export interface ObservedPlayer {
    playerId: number;
    bohemiaUserId: string;
    currentNickname: string;
    aliases: string[];
    platforms: PlayerPlatform[];
    firstSeenAt: Date;
    lastSeenAt: Date;
    //undefined — игрок не в игре прямо сейчас.
    online: PlayerLocation | undefined;
    lastServer: PlayerLocation | undefined;
    sessionsTotal: number;
}

//Результат поиска. fuzzy означает «точных совпадений не нашлось, это похожие по написанию»:
//бот обязан сказать об этом человеку, а не выдавать их за найденных.
export interface PlayerSearchResult {
    players: ObservedPlayer[];
    fuzzy: boolean;
}

export interface PlayerSession {
    serverId: number;
    serverName: string;
    //Ник, под которым игрок был в этом визите. Может отличаться от текущего.
    nickname: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
    endedAt: Date | undefined;
    status: string;
    durationSeconds: number;
}

//Всё, что бот спрашивает у наблюдателя. Узкий интерфейс: ни подписок, ни чатов там нет —
//они наши и живут в нашей БД.
//Данные Steam об игроке. Поля необязательные не для красоты: закрытый профиль, скрытые игры
//и несобранные баны — три разных вида «неизвестно», и показывать их нулями было бы враньём.
export interface SteamProfile {
    personaName: string;
    realName: string;
    profileUrl: string;
    countryCode: string;
    createdAt?: Date | undefined;
    visibility?: number | undefined;
    vacBanned?: boolean | undefined;
    vacBanCount?: number | undefined;
    gameBanCount?: number | undefined;
    reforgerMinutes?: number | undefined;
    reforgerMinutes2w?: number | undefined;
    gamesVisible: boolean;
    friendsVisible: boolean;
    updatedAt: Date;
}

//Друг из Steam. playerId заполнен, если этот человек встречался на наблюдаемых серверах —
//ради этого сопоставления граф и хранится.
export interface DossierFriend {
    steamId: string;
    since?: Date | undefined;
    playerId?: number | undefined;
    nickname: string;
    lastSeenAt?: Date | undefined;
}

export interface PlayerDossier {
    playerId: number;
    steamId: string;
    //undefined — данные ещё ни разу не собрались. Это НЕ то же самое, что «профиль закрыт»:
    //закрытый профиль мы видели и знаем, что он закрыт, а тут мы не дошли до Valve вовсе.
    //lastError объясняет почему.
    profile?: SteamProfile | undefined;
    lastError: string;
    friends: DossierFriend[];
    friendsKnown: number;
}

export interface PlayerObserver {
    //id последнего события на сейчас. Нужен один раз — чтобы начать читать ленту с «сегодня»,
    //а не с начала времён.
    eventsHead(): Promise<number>;

    //Страница ленты после курсора. playerIds пуст — фильтра нет; передавать пустой список
    //как фильтр нельзя, иначе вернётся всё подряд.
    events(after: number, playerIds: readonly number[], limit: number): Promise<PlayerEventsPage>;

    searchPlayers(nickname: string, limit: number): Promise<PlayerSearchResult>;

    //Карточки нескольких игроков одним запросом: статус всех подписок чата.
    playersByIds(ids: readonly number[]): Promise<ObservedPlayer[]>;

    player(playerId: number): Promise<ObservedPlayer | undefined>;

    sessions(playerId: number, limit: number): Promise<PlayerSession[]>;

    trackedServers(): Promise<ObservedServer[]>;

    //Досье Steam. Обращение к нему на стороне наблюдателя ЗАОДНО ставит игрока на регулярное
    //обновление: интерес человека — лучший признак «этот игрок важен».
    //
    //null — у игрока не наблюдалось Steam-аккаунта (играет с консоли). Именно null, а не
    //undefined: undefined от withObserver означает «наблюдатель недоступен», и путать
    //«ответил, что нечего показать» с «не ответил» нельзя — сообщения человеку разные.
    dossier(playerId: number): Promise<PlayerDossier | null>;
}

//Наблюдатель не отвечает или отвечает мусором. Отдельный тип, чтобы команды могли сказать человеку
//«сервис наблюдения недоступен» вместо общего «что-то пошло не так», а рассылка — промолчать
//и повторить попытку на следующем тике, не двигая курсор.
export class PlayerObserverUnavailable extends Error {
    public constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = "PlayerObserverUnavailable";
    }
}
