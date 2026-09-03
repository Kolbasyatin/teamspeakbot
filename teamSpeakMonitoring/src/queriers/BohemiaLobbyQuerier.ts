import {
    narrowQueryConfig,
    type BohemiaQueryConfig,
    type Querier,
    type ServerQueryConfig,
    type ServerQueryResult,
} from "../monitoring/ServerQuery.js";
import type {BiTokenSource} from "./BiTokenProvider.js";
import {fetchJson} from "./fetchJson.js";
import type {Logger} from "pino";

//Протокольные константы каталога Bohemia. Одинаковы для всех серверов, поэтому живут в env,
//а не в строке источника. Меняются с патчами игры: бэкенд проверяет User-Agent и clientVersion,
//и после обновления Reforger их, возможно, придётся поправить. Значения сняты с клиента 1.8.0.
export interface BohemiaLobbyProperties {
    lobbyUrl: string;
    userAgent: string;
    clientVersion: string;
    platformId: string;
    gameClientType: string;
}

//Источник данных — тот же каталог, что кормит внутриигровой браузер серверов: POST rooms/search
//с фильтром по hostAddress. Единственный из источников, кто знает очередь на вход: A2S её
//не отдаёт, а игровой сервер сам сообщает её бэкенду с heartbeat'ом.
//
//Единственное место, знающее форму ответа Bohemia. Карты полей нет: протокол фиксирован,
//мапинг — код, как у A2S. Ответ приходит с задержкой heartbeat'а (десятки секунд), поэтому
//вместе с данными отдаётся dataUpdatedAt — потребитель сам решит, что показать рядом с очередью.
//
//Работает только второстепенным: доступность каталога и токена никак не связана с жизнью
//игрового сервера, и делать её индикатором online/offline нельзя. Архитектура этого не запрещает,
//но включать так не стоит.
export class BohemiaLobbyQuerier implements Querier {
    constructor(
        private readonly properties: BohemiaLobbyProperties,
        private readonly tokens: BiTokenSource,
        private readonly logger: Logger,
    ) {
    }

    public async query(config: ServerQueryConfig): Promise<ServerQueryResult | undefined> {
        const bohemiaConfig = narrowQueryConfig(config, "bohemia");
        const token = await this.tokens.getToken();

        //Нет токена — нет запроса. Причину уже залогировал провайдер, здесь только факт.
        if (!token) {
            this.logger.debug(`Bohemia query skipped for ${bohemiaConfig.hostAddress}: no access token`);
            return undefined;
        }

        try {
            const response = await fetchJson(this.properties.lobbyUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": this.properties.userAgent,
                },
                body: JSON.stringify(this.searchBody(bohemiaConfig.hostAddress, token)),
                timeoutMs: bohemiaConfig.timeout,
            });

            //Бэкенд отверг токен: он протух раньше, чем мы думали, или его отозвали. Сбрасываем кэш,
            //следующий тик пойдёт за свежим. Повторять запрос сразу не нужно — интервал опроса
            //второстепенных и так задаёт темп.
            if (response.status === 401 || response.status === 403) {
                this.tokens.invalidate();
                this.logger.debug(`Bohemia rejected the access token (HTTP ${response.status}), cache dropped`);
                return undefined;
            }

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return this.toQueryResult(response.body, bohemiaConfig);
        } catch (error) {
            this.logger.debug(`Bohemia query failed for ${bohemiaConfig.hostAddress}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    //Тело запроса — минимальное из того, что бэкенд принимает; снято с живого клиента.
    //ascendent обязателен: без него бэкенд отвечает InvalidInput. Фильтра modded нет намеренно:
    //он ограничивает выдачу, а нам нужен сервер по адресу, каким бы он ни был.
    //limit больше единицы на случай, если за одним адресом бэкенд знает несколько комнат:
    //нужную выбирает toQueryResult по точному совпадению hostAddress.
    private searchBody(hostAddress: string, accessToken: string): Record<string, unknown> {
        return {
            hostAddress,
            order: "PlayerCount",
            ascendent: false,
            gameClientFilter: "AnyCompatible",
            accessToken,
            clientVersion: this.properties.clientVersion,
            platformId: this.properties.platformId,
            gameClientType: this.properties.gameClientType,
            lightweight: false,
            from: 0,
            limit: 5,
            pingValues: [],
        };
    }

    //Ответ: {rooms: [...], searchFrom, totalCount}. Комната, которой нет в каталоге, — это
    //неудачный опрос источника, а не пустой результат: сервер либо не зарегистрирован в Bohemia,
    //либо сменил адрес. Оба случая должны быть видны в debug-логе, а не выглядеть как «очередь
    //неизвестна».
    private toQueryResult(payload: unknown, config: BohemiaQueryConfig): ServerQueryResult | undefined {
        const rooms = (payload as {rooms?: unknown} | null)?.rooms;

        if (!Array.isArray(rooms)) {
            this.logger.debug(`Bohemia response for ${config.hostAddress} has no rooms array`);
            return undefined;
        }

        const room = rooms.find((candidate): candidate is Room =>
            isObject(candidate) && candidate.hostAddress === config.hostAddress);

        if (!room) {
            this.logger.debug(`Bohemia catalog has no room for ${config.hostAddress}`);
            return undefined;
        }

        return toDomain(room);
    }
}

//Ровно те поля ответа, которые домен читает. Остальные два десятка (mods, battlEye, sessionId,
//runtimeStats и т.д.) здесь и остаются, как у A2S остаются его лишние тринадцать.
interface Room {
    hostAddress: string;
    playerCount?: unknown;
    playerCountLimit?: unknown;
    scenarioName?: unknown;
    directJoinCode?: unknown;
    //Секунды эпохи: момент последнего heartbeat сервера в каталог.
    updated?: unknown;
    joinQueue?: unknown;
}

//Поле за полем, как в RestQuerier: непригодное значение пропускается, а не роняет ответ.
//Значение проверяется по типу, а не приводится: строка вместо числа — сломанный контракт,
//и молча чинить его не нужно.
function toDomain(room: Room): ServerQueryResult {
    const queue = isObject(room.joinQueue) ? room.joinQueue : {};
    const result: ServerQueryResult = {};

    setNumber(result, "players", room.playerCount);
    setNumber(result, "maxPlayers", room.playerCountLimit);
    setNumber(result, "queueSize", queue["size"]);
    setNumber(result, "queueMaxSize", queue["maxSize"]);
    setNumber(result, "queueAvgWaitTime", queue["positionAvgWaitTime"]);
    setString(result, "scenarioName", room.scenarioName);
    setString(result, "directJoinCode", room.directJoinCode);

    if (Number.isFinite(room.updated)) {
        result.dataUpdatedAt = (room.updated as number) * 1000;
    }

    return result;
}

type NumberField = {[K in keyof ServerQueryResult]-?: ServerQueryResult[K] extends number | undefined ? K : never}[keyof ServerQueryResult];
type StringField = {[K in keyof ServerQueryResult]-?: ServerQueryResult[K] extends string | undefined ? K : never}[keyof ServerQueryResult];

function setNumber(result: ServerQueryResult, field: NumberField, value: unknown): void {
    if (Number.isFinite(value)) {
        result[field] = value as number;
    }
}

function setString(result: ServerQueryResult, field: StringField, value: unknown): void {
    if (typeof value === "string" && value !== "") {
        result[field] = value;
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
