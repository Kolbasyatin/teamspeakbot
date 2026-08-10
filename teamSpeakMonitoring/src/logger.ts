import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const defaultLevel = isDev ? "debug" : "info";

//Сериализатор ошибок в pino привязан к ключу. По умолчанию это "err", а в проекте принято
//писать {error}, поэтому без этой настройки Error уходил в обычный JSON.stringify: поля message
//и stack у Error неперечисляемые, и в логе оставалось "error": {}.
const errorKey = "error";

//Время пишем сами. Полагаться на то, что его проставит journald или docker, нельзя: снаружи
//контейнера этого никто не делает, а лог у нас — единственная история состояния серверов,
//и без времени по нему нельзя восстановить ни динамику, ни момент падения.
export const log = pino({
    level: process.env.LOG_LEVEL ?? defaultLevel,
    base: null,
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