import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const defaultLevel = isDev ? "debug" : "info";

//Сериализатор ошибок в pino привязан к ключу. По умолчанию это "err", а в проекте принято
//писать {error}, поэтому без этой настройки Error уходил в обычный JSON.stringify: поля message
//и stack у Error неперечисляемые, и в логе оставалось "error": {}.
const errorKey = "error";

export const log = pino({
    level: process.env.LOG_LEVEL ?? defaultLevel,
    base: null,
    timestamp: false,
    errorKey,
    ...(isDev ? {
            transport: {
                target: "pino-pretty",
                options: {
                    colorize: true,
                    translateTime: "SYS:standard",
                    ignore: "pid,hostname",
                    //pino-pretty ищет ошибку по своему ключу, ему нужно сказать отдельно.
                    errorKey,
                },
            },
        }
        : {}),
});