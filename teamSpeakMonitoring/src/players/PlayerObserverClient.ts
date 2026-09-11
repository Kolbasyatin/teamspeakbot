import {fetchJson} from "../queriers/fetchJson.js";
import {
    PlayerObserverUnavailable,
    type ObservedPlayer,
    type ObservedServer,
    type PlayerEvent,
    type PlayerEventsPage,
    type PlayerLocation,
    type PlayerObserver,
    type PlayerPlatform,
    type PlayerSearchResult,
    type PlayerSession,
} from "./PlayerObserver.js";

export interface PlayerObserverClientProperties {
    //Пустой baseUrl выключает всё, что про игроков: ни команд, ни ленты. Как пустой BOHEMIA_TOKEN_URL
    //выключает bohemia-источники.
    baseUrl: string;
    apiToken: string;
    timeoutMs: number;
}

//Единственное место, которое знает, что наблюдатель — это HTTP и JSON. Наружу отдаёт типы
//из PlayerObserver.ts; форма чужого ответа за пределы файла не выходит.
//
//Разбор ответа не доверяет присланному: чужой сервис может измениться раньше нас, и молча
//уехавший undefined в текст сообщения хуже отказа. Поэтому каждое поле проверяется по типу,
//а не приводится.
export class PlayerObserverClient implements PlayerObserver {
    public constructor(private readonly properties: PlayerObserverClientProperties) {
    }

    public async eventsHead(): Promise<number> {
        const body = await this.get("/events/head");

        return asNumber(readField(body, "head")) ?? 0;
    }

    public async events(after: number, playerIds: readonly number[], limit: number): Promise<PlayerEventsPage> {
        const query = new URLSearchParams({after: String(after), limit: String(limit)});

        //Пустой фильтр не передаётся вовсе: параметр с пустым значением означал бы «все игроки»,
        //и на чат без подписок приехала бы вся лента.
        if (playerIds.length > 0) {
            query.set("player_ids", playerIds.join(","));
        }

        const body = await this.get(`/events?${query.toString()}`);
        const events = asArray(readField(body, "events")).flatMap(item => {
            const event = parseEvent(item);

            return event ? [event] : [];
        });

        return {
            events,
            //Курсор берём из ответа, а не из максимума по событиям: сервис знает лучше, докуда
            //лента прочитана, — например, когда все события страницы отфильтрованы.
            nextAfter: asNumber(readField(body, "next_after")) ?? after,
        };
    }

    public async searchPlayers(nickname: string, limit: number): Promise<PlayerSearchResult> {
        const query = new URLSearchParams({nick: nickname, limit: String(limit)});
        const body = await this.get(`/players?${query.toString()}`);

        return {
            players: parsePlayers(body),
            fuzzy: readField(body, "fuzzy") === true,
        };
    }

    public async playersByIds(ids: readonly number[]): Promise<ObservedPlayer[]> {
        if (ids.length === 0) {
            return [];
        }

        const query = new URLSearchParams({ids: ids.join(",")});

        return parsePlayers(await this.get(`/players?${query.toString()}`));
    }

    public async player(playerId: number): Promise<ObservedPlayer | undefined> {
        //404 здесь не отказ сервиса, а ответ «такого нет»: подписка могла пережить чистку у соседа.
        const body = await this.get(`/players/${playerId}`, [404]);

        return body === undefined ? undefined : parsePlayer(body);
    }

    public async sessions(playerId: number, limit: number): Promise<PlayerSession[]> {
        const query = new URLSearchParams({limit: String(limit)});
        const body = await this.get(`/players/${playerId}/sessions?${query.toString()}`);

        return asArray(readField(body, "sessions")).flatMap(item => {
            const session = parseSession(item);

            return session ? [session] : [];
        });
    }

    public async trackedServers(): Promise<ObservedServer[]> {
        const body = await this.get("/servers?tracked=true");

        return asArray(readField(body, "servers")).flatMap(item => {
            const server = parseServer(item);

            return server ? [server] : [];
        });
    }

    //Один путь наружу для всех методов: авторизация, таймаут и превращение любой беды
    //в PlayerObserverUnavailable. Коды из notFoundAs отдаются как undefined — это ответ, а не отказ.
    private async get(path: string, notFoundAs: readonly number[] = []): Promise<unknown> {
        if (this.properties.baseUrl === "") {
            throw new PlayerObserverUnavailable("Наблюдатель за игроками не настроен");
        }

        let response;

        try {
            response = await fetchJson(`${this.properties.baseUrl}${path}`, {
                timeoutMs: this.properties.timeoutMs,
                headers: {Authorization: `Bearer ${this.properties.apiToken}`},
            });
        } catch (error) {
            //Сеть, таймаут, DNS: наружу это одно и то же — сервис недоступен.
            throw new PlayerObserverUnavailable(`Запрос к наблюдателю не удался: ${path}`, error);
        }

        if (notFoundAs.includes(response.status)) {
            return undefined;
        }

        if (!response.ok) {
            throw new PlayerObserverUnavailable(`Наблюдатель ответил ${response.status} на ${path}`);
        }

        return response.body;
    }
}

//Ниже — разбор чужого JSON. Функции свободные и чистые: их проверяют тестом без сети.

function readField(value: unknown, field: string): unknown {
    return isObject(value) ? value[field] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

//Время приезжает строкой RFC 3339 в UTC. Непарсящееся значение — не дата, а не «начало эпохи»:
//Invalid Date в тексте сообщения заметят, а 1970 год выглядит как настоящий.
function asDate(value: unknown): Date | undefined {
    const text = asString(value);

    if (text === undefined) {
        return undefined;
    }

    const date = new Date(text);

    return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseLocation(value: unknown): PlayerLocation | undefined {
    const id = asNumber(readField(value, "id"));
    const name = asString(readField(value, "name"));

    if (id === undefined || name === undefined) {
        return undefined;
    }

    return {serverId: id, serverName: name, since: asDate(readField(value, "since"))};
}

function parsePlatform(value: unknown): PlayerPlatform | undefined {
    const type = asString(readField(value, "type"));
    const id = asString(readField(value, "id"));

    return type === undefined || id === undefined ? undefined : {type, id};
}

function parsePlayers(body: unknown): ObservedPlayer[] {
    return asArray(readField(body, "players")).flatMap(item => {
        const player = parsePlayer(item);

        return player ? [player] : [];
    });
}

//Игрок без id или ника бесполезен — такую запись пропускаем, а не показываем пустую строку.
function parsePlayer(value: unknown): ObservedPlayer | undefined {
    const playerId = asNumber(readField(value, "player_id"));
    const nickname = asString(readField(value, "current_nickname"));
    const firstSeenAt = asDate(readField(value, "first_seen_at"));
    const lastSeenAt = asDate(readField(value, "last_seen_at"));

    if (playerId === undefined || nickname === undefined || !firstSeenAt || !lastSeenAt) {
        return undefined;
    }

    return {
        playerId,
        bohemiaUserId: asString(readField(value, "bohemia_user_id")) ?? "",
        currentNickname: nickname,
        aliases: asArray(readField(value, "aliases")).flatMap(alias => {
            const text = asString(alias);

            return text === undefined ? [] : [text];
        }),
        platforms: asArray(readField(value, "platforms")).flatMap(item => {
            const platform = parsePlatform(item);

            return platform ? [platform] : [];
        }),
        firstSeenAt,
        lastSeenAt,
        online: parseLocation(readField(value, "online")),
        lastServer: parseLocation(readField(value, "last_server")),
        sessionsTotal: asNumber(readField(value, "sessions_total")) ?? 0,
    };
}

function parseEvent(value: unknown): PlayerEvent | undefined {
    const id = asNumber(readField(value, "id"));
    const type = asString(readField(value, "type"));
    const occurredAt = asDate(readField(value, "occurred_at"));
    const playerId = asNumber(readField(value, "player_id"));

    if (id === undefined || type === undefined || !occurredAt || playerId === undefined) {
        return undefined;
    }

    const payload = readField(value, "payload");

    return {
        id,
        type,
        occurredAt,
        playerId,
        nickname: asString(readField(value, "nickname")) ?? "",
        serverId: asNumber(readField(value, "server_id")),
        serverName: asString(readField(value, "server_name")) ?? "",
        durationSeconds: asNumber(readField(value, "duration_seconds")),
        payload: isObject(payload) ? payload : {},
        afterDataGap: readField(value, "after_data_gap") === true,
    };
}

function parseSession(value: unknown): PlayerSession | undefined {
    const serverId = asNumber(readField(value, "server_id"));
    const firstSeenAt = asDate(readField(value, "first_seen_at"));
    const lastSeenAt = asDate(readField(value, "last_seen_at"));

    if (serverId === undefined || !firstSeenAt || !lastSeenAt) {
        return undefined;
    }

    return {
        serverId,
        serverName: asString(readField(value, "server_name")) ?? "",
        nickname: asString(readField(value, "nickname")) ?? "",
        firstSeenAt,
        lastSeenAt,
        endedAt: asDate(readField(value, "ended_at")),
        status: asString(readField(value, "status")) ?? "",
        durationSeconds: asNumber(readField(value, "duration_seconds")) ?? 0,
    };
}

function parseServer(value: unknown): ObservedServer | undefined {
    const id = asNumber(readField(value, "id"));
    const name = asString(readField(value, "name"));

    if (id === undefined || name === undefined) {
        return undefined;
    }

    return {
        id,
        name,
        hostAddress: asString(readField(value, "host_address")) ?? "",
        tracked: readField(value, "tracked") === true,
        players: asNumber(readField(value, "players")),
        playerLimit: asNumber(readField(value, "player_limit")),
        queue: asNumber(readField(value, "queue")),
    };
}
