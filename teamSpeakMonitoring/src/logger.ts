import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const log = pino({
    level: process.env.LOG_LEVEL ?? "info",
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