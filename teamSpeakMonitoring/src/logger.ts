import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const defaultLevel = isDev ? "debug" : "info";

export const log = pino({
    level: process.env.LOG_LEVEL ?? defaultLevel,
    base: null,
    timestamp: false,
    ...(isDev ? {
            transport: {
                target: "pino-pretty",
                options: {
                    colorize: true,
                    translateTime: "SYS:standard",
                    ignore: "pid,hostname",
                },
            },
        }
        : {}),
});