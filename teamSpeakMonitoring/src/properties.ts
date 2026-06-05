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

export interface TSNotifierChannelNames {
    channels: string[];
}

const channelsNotifierName = convict<TSNotifierChannelNames>({
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
channelsNotifierName.validate({allowed: "strict"});
tgConfig.validate({allowed: "strict"});

export const properties: TeamSpeakProperties = config.getProperties();
export const dbConfig = databaseConfig.getProperties()
export const syncConfig = syncServerConfig.getProperties()
export const tsNotifierChannelNames = channelsNotifierName.getProperties();
export const tgProperties = tgConfig.getProperties();
