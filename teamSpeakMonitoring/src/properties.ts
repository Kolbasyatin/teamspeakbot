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
}

export interface MonitorProperties {
    pollIntervalMs: number;
    suspiciousPollIntervalMs: number;
    maxFailedChecks: number;
    secondaryGraceMs: number;
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

export const properties: TeamSpeakProperties = config.getProperties();
export const dbConfig = databaseConfig.getProperties()
export const syncConfig = syncServerConfig.getProperties()
export const teamSpeakChannelNames = teamSpeakChannelsConfig.getProperties();
export const tgProperties = tgConfig.getProperties();
export const monitorProperties = monitorConfig.getProperties();
export const stateSyncProperties = stateSyncConfig.getProperties();