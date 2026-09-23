import "dotenv-flow/config";
import convict from "convict";
import {TeamSpeak} from "ts3-nodejs-library";

//env через запятую превращаем в массив
convict.addFormat({
    name: "comma-separated-string-array",
    validate: (value: unknown): void => {
        if (!Array.isArray(value)) {
            throw new Error("must be an array");
        }

        for (const item of value) {
            if (typeof item !== "string" || item.trim() === "") {
                throw new Error("must contain only non-empty strings");
            }
        }
    },
    coerce: (value: unknown): string[] => {
        if (Array.isArray(value)) {
            return value;
        }

        if (typeof value !== "string") {
            return [];
        }

        return value
            .split(",")
            .map(item => item.trim())
            .filter(Boolean);
    },
});


export interface TeamSpeakProperties {
    host: string;
    queryport: number;
    username: string;
    password: string;
    protocol: TeamSpeak.QueryProtocol;
}

export interface TeamSpeakChannelNames {
    channels: string[];
}

const teamSpeakChannelsConfig = convict<TeamSpeakChannelNames>({
    channels: {
        doc: "TeamSpeak channel names for notifier",
        format: "comma-separated-string-array",
        default: ["ServerInfo"],
        env: "TS_NOTIFY_CHANNELS",
    },
});

export interface DatabaseProperties {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectionLimit: number;
}

export interface SyncServerPort {
    port: number;
}

export interface TGProperties {
    token: string;
    channelId: string;
    updateTimeoutMs: number;
}

export interface MonitorProperties {
    pollIntervalMs: number;
    suspiciousPollIntervalMs: number;
    maxFailedChecks: number;
    secondaryGraceMs: number;
    secondaryPollIntervalMs: number;
}

const monitorConfig = convict<MonitorProperties>({
    pollIntervalMs: {
        doc: "Default server poll interval in milliseconds",
        format: "nat",
        default: 5_000,
        env: "MONITOR_POLL_INTERVAL_MS",
    },
    suspiciousPollIntervalMs: {
        doc: "Poll interval in milliseconds after failed probe",
        format: "nat",
        default: 1_000,
        env: "MONITOR_SUSPICIOUS_POLL_INTERVAL_MS",
    },
    maxFailedChecks: {
        doc: "Failed checks before server is marked offline",
        format: "nat",
        default: 5,
        env: "MONITOR_MAX_FAILED_CHECKS",
    },
    //Отсчитывается ОТ ответа главного источника, а не от начала опроса: иначе быстрые
    //второстепенные съедали бы бюджет главного, и тот отваливался бы по чужому таймауту.
    //Свой timeout у каждого источника лежит в его query_config, здесь только добавка.
    secondaryGraceMs: {
        doc: "How long to wait for secondary sources after the primary one has answered",
        format: "nat",
        default: 1_000,
        env: "MONITOR_SECONDARY_GRACE_MS",
    },
    //Нижняя граница между двумя опросами одного второстепенного источника. Тик сервера при этом
    //один: второстепенный, опрошенный недавно, отдаёт в слияние прошлый ответ (см.
    //SecondarySourceThrottle). Ноль — опрашивать второстепенные каждый тик, как главный.
    //Умолчание подобрано по каталогу Bohemia: данные там обновляются heartbeat'ом сервера
    //с шагом в десятки секунд, чаще спрашивать нечего.
    secondaryPollIntervalMs: {
        doc: "Minimum interval between two polls of the same secondary source; 0 polls every tick",
        format: "nat",
        default: 30_000,
        env: "MONITOR_SECONDARY_POLL_INTERVAL_MS",
    },
});

//Каталог серверов Bohemia: соседний сервис с токеном и протокольные константы игры.
//Всё, что одинаково для всех серверов, лежит здесь, а не в строках источников: вышел патч —
//правится одна переменная. Пустой tokenUrl выключает bohemia-источники целиком (см. BiTokenProvider).
export interface BohemiaProperties {
    tokenUrl: string;
    tokenTimeoutMs: number;
    tokenRefreshLeadMs: number;
    lobbyUrl: string;
    userAgent: string;
    clientVersion: string;
    platformId: string;
    gameClientType: string;
}

//Соседний сервис наблюдения за игроками (armaplayers, репозиторий arma-players-backend).
//Пустой baseUrl выключает всё, что про игроков: ни команд, ни ленты событий, — ровно как пустой
//BOHEMIA_TOKEN_URL выключает bohemia-источники. Мониторинг серверов от этого не зависит.
export interface PlayerObserverProperties {
    baseUrl: string;
    apiToken: string;
    timeoutMs: number;
    //Отдельный, БОЛЬШОЙ таймаут для досье. Обычные запросы к наблюдателю — это чтение из его
    //базы, доли секунды. Досье при первом обращении идёт дальше: наблюдатель синхронно ходит
    //в arma-reforger-hz, тот — в четыре метода Valve. Десять секунд там нормальны, и общих
    //пяти не хватало: бот отваливался по таймауту ровно тогда, когда данные наконец собирались.
    dossierTimeoutMs: number;
    //Как часто спрашивать новые события. Задержка уведомления складывается из этого интервала
    //и интервала наблюдения на стороне соседа (там минуты), поэтому чаще нескольких секунд смысла нет.
    eventIntervalMs: number;
    //Размер страницы ленты: ограничивает всплеск при массовом заходе на популярный сервер.
    eventPageSize: number;
    //Как часто перепроверять отложенные подписки («появится игрок с таким ником — подпиши меня»).
    pendingIntervalMs: number;
    //Сколько живёт такое ожидание и сколько их разрешено одному чату.
    pendingTtlMs: number;
    pendingLimit: number;
}

const playerObserverConfig = convict<PlayerObserverProperties>({
    baseUrl: {
        doc: "Base URL of the armaplayers observer REST API; empty disables player features",
        format: String,
        default: "",
        env: "PLAYERS_API_URL",
    },
    apiToken: {
        doc: "Bearer token for the observer API",
        format: String,
        default: "",
        env: "PLAYERS_API_TOKEN",
        sensitive: true,
    },
    timeoutMs: {
        doc: "Timeout for observer API requests in milliseconds",
        format: "nat",
        default: 5_000,
        env: "PLAYERS_API_TIMEOUT_MS",
    },
    dossierTimeoutMs: {
        doc: "Timeout for the Steam dossier request; it collects data synchronously on first call",
        format: "nat",
        default: 30_000,
        env: "PLAYERS_DOSSIER_TIMEOUT_MS",
    },
    eventIntervalMs: {
        doc: "How often the player event feed is polled",
        format: "nat",
        default: 15_000,
        env: "PLAYERS_EVENT_INTERVAL_MS",
    },
    eventPageSize: {
        doc: "Max events fetched per poll",
        format: "nat",
        default: 200,
        env: "PLAYERS_EVENT_PAGE_SIZE",
    },
    pendingIntervalMs: {
        doc: "How often pending nickname subscriptions are re-checked",
        format: "nat",
        default: 300_000,
        env: "PLAYERS_PENDING_INTERVAL_MS",
    },
    pendingTtlMs: {
        doc: "How long a pending nickname subscription lives",
        format: "nat",
        default: 30 * 24 * 60 * 60 * 1_000,
        env: "PLAYERS_PENDING_TTL_MS",
    },
    pendingLimit: {
        doc: "How many pending nickname subscriptions one chat may have",
        format: "nat",
        default: 5,
        env: "PLAYERS_PENDING_LIMIT",
    },
});

const bohemiaConfig = convict<BohemiaProperties>({
    tokenUrl: {
        doc: "GET endpoint of the arma-reforger-hz token service; empty disables bohemia sources",
        format: String,
        default: "",
        env: "BOHEMIA_TOKEN_URL",
    },
    tokenTimeoutMs: {
        doc: "Timeout for the token service request in milliseconds",
        format: "nat",
        default: 3_000,
        env: "BOHEMIA_TOKEN_TIMEOUT_MS",
    },
    tokenRefreshLeadMs: {
        doc: "How long before expiresAt the cached token is treated as expired",
        format: "nat",
        default: 60_000,
        env: "BOHEMIA_TOKEN_REFRESH_LEAD_MS",
    },
    lobbyUrl: {
        doc: "Bohemia lobby rooms/search endpoint",
        format: String,
        default: "https://api-ar-game.bistudio.com/game-api/api/v1.0/lobby/rooms/search",
        env: "BOHEMIA_LOBBY_URL",
    },
    userAgent: {
        doc: "User-Agent of the game client; Bohemia checks it, changes with game patches",
        format: String,
        default: "Arma Reforger/1.8.0.10 (Client; Windows)",
        env: "BOHEMIA_USER_AGENT",
    },
    clientVersion: {
        doc: "clientVersion field of lobby requests; changes with game patches",
        format: String,
        default: "1.8.0",
        env: "BOHEMIA_CLIENT_VERSION",
    },
    platformId: {
        doc: "platformId field of lobby requests",
        format: String,
        default: "ReforgerSteam",
        env: "BOHEMIA_PLATFORM_ID",
    },
    gameClientType: {
        doc: "gameClientType field of lobby requests",
        format: String,
        default: "PLATFORM_PC",
        env: "BOHEMIA_GAME_CLIENT_TYPE",
    },
});

//Правило «похоже, раунд заканчивается». Отдельно от MonitorProperties: монитор про раунды
//не знает и знать не должен. Значения подобраны не на глаз, а по разбору двух суток прод-логов —
//см. telegram.md, §11.
export interface RoundFinishProperties {
    windowMs: number;
    drop: number;
    minBase: number;
    //Ниже этого числа считаем, что сервер перезапустился и историю прошлой сессии надо забыть.
    emptyPlayers: number;
}

const roundFinishConfig = convict<RoundFinishProperties>({
    windowMs: {
        doc: "Window in milliseconds used to compute the player-count baseline",
        format: "nat",
        default: 60_000,
        env: "ROUND_FINISH_WINDOW_MS",
    },
    drop: {
        doc: "Relative drop from the baseline that triggers the signal (0.25 = a quarter)",
        format: Number,
        default: 0.25,
        env: "ROUND_FINISH_DROP",
    },
    minBase: {
        doc: "Minimum baseline players; below it a drop is not a round finish",
        format: "nat",
        default: 20,
        env: "ROUND_FINISH_MIN_BASE",
    },
    emptyPlayers: {
        doc: "Player count that means the session restarted and history must be dropped",
        format: "nat",
        default: 2,
        env: "ROUND_FINISH_EMPTY_PLAYERS",
    },
});

//Период повторной публикации текущего состояния. Отдельно от MonitorProperties намеренно:
//монитор про эту периодику не знает, тик живёт в composition root. Имя переменной оставлено
//в семье MONITOR_*, потому что речь о состоянии, которое собирает монитор.
export interface StateSyncProperties {
    intervalMs: number;
}

const stateSyncConfig = convict<StateSyncProperties>({
    intervalMs: {
        doc: "Interval in milliseconds between republishing current server state",
        format: "nat",
        default: 60_000,
        env: "MONITOR_STATE_SYNC_INTERVAL_MS",
    },
});

//Отдельно от TeamSpeakProperties: те целиком уходят в TeamSpeak.connect(), а это не параметр
//библиотеки, а наша защита от неё — у ts3-nodejs-library нет таймаута на команду.
export interface TeamSpeakQueryProperties {
    timeoutMs: number;
}

const teamSpeakQueryConfig = convict<TeamSpeakQueryProperties>({
    timeoutMs: {
        doc: "Timeout in milliseconds for one TeamSpeak operation, including connect",
        format: "nat",
        default: 10_000,
        env: "TS_QUERY_TIMEOUT_MS",
    },
});

const syncServerConfig = convict<SyncServerPort>({
    port: {
        doc: "Sync Server port",
        format: "port",
        default: 3000,
        env: "SYNC_SERVER_PORT",
    },
});

const tgConfig = convict<TGProperties>({
    token: {
        doc: "Telegram Bot Token",
        format: String,
        default: "",
        env: "TELEGRAM_TOKEN",
    },
    channelId: {
        doc: "Telegram Channel ID",
        format: String,
        default: "",
        env: "TELEGRAM_CHANNEL_ID",
    },
    updateTimeoutMs: {
        doc: "Deadline in milliseconds for handling one Telegram update before polling moves on",
        format: "nat",
        default: 60_000,
        env: "TELEGRAM_UPDATE_TIMEOUT_MS",
    },
});

const config = convict<TeamSpeakProperties>({
    host: {
        doc: "TeamSpeak host",
        format: String,
        default: "127.0.0.1",
        env: "TS_HOST",
    },
    queryport: {
        doc: "TeamSpeak port",
        format: "port",
        default: 10022,
        env: "TS_PORT",
    },
    username: {
        doc: "TeamSpeak login",
        format: String,
        default: "",
        env: "TS_USERNAME",
    },
    password: {
        doc: "TeamSpeak password",
        format: String,
        default: "",
        env: "TS_PASSWORD",
    },
    protocol: {
        doc: "TeamSpeak Proto",
        default: TeamSpeak.QueryProtocol.SSH
    }
});

const databaseConfig = convict<DatabaseProperties>({
    host: {
        doc: "MariaDB host",
        format: String,
        default: "127.0.0.11",
        env: "DB_HOST",
    },
    port: {
        doc: "MariaDB port",
        format: "port",
        default: 3306,
        env: "DB_PORT",
    },
    user: {
        doc: "MariaDB user",
        format: String,
        default: "teamspeak",
        env: "DB_USER",
    },
    password: {
        doc: "MariaDB password",
        format: String,
        default: "",
        env: "DB_PASSWORD",
    },
    database: {
        doc: "MariaDB database",
        format: String,
        default: "tsbot",
        env: "DB_NAME",
    },
    connectionLimit: {
        doc: "MariaDB pool connection limit",
        format: "nat",
        default: 2,
        env: "DB_CONNECTION_LIMIT",
    },
});

config.validate({allowed: "strict"});
databaseConfig.validate({allowed: "strict"});
syncServerConfig.validate({allowed: "strict"});
teamSpeakChannelsConfig.validate({allowed: "strict"});
tgConfig.validate({allowed: "strict"});
monitorConfig.validate({allowed: "strict"});
stateSyncConfig.validate({allowed: "strict"});
teamSpeakQueryConfig.validate({allowed: "strict"});
bohemiaConfig.validate({allowed: "strict"});
playerObserverConfig.validate({allowed: "strict"});

export const properties: TeamSpeakProperties = config.getProperties();
export const dbConfig = databaseConfig.getProperties()
export const syncConfig = syncServerConfig.getProperties()
export const teamSpeakChannelNames = teamSpeakChannelsConfig.getProperties();
export const tgProperties = tgConfig.getProperties();
export const monitorProperties = monitorConfig.getProperties();
export const stateSyncProperties = stateSyncConfig.getProperties();
export const teamSpeakQueryProperties = teamSpeakQueryConfig.getProperties();
export const roundFinishProperties = roundFinishConfig.getProperties();
export const bohemiaProperties = bohemiaConfig.getProperties();
export const playerObserverProperties = playerObserverConfig.getProperties();