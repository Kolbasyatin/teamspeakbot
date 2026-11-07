import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";
const defaultLevel = isDev ? "debug" : "info";

//Сериализатор ошибок в pino привязан к ключу. По умолчанию это "err", а в проекте принято
//писать {error}, поэтому без этой настройки Error уходил в обычный JSON.stringify: поля message
//и stack у Error неперечисляемые, и в логе оставалось "error": {}.
const errorKey = "error";

//Токен бота Telegram стоит в адресе КАЖДОГО запроса к Bot API (https://api.telegram.org/bot<токен>/...),
//а сетевая ошибка fetch пишет этот адрес в message и stack. Ошибки у нас логируются целиком и из
//многих мест (диагностика, bot.catch, доставка уведомлений), и токен оказывался в прод-логе
//(найдено 2026-11-07). Поэтому чистим на выходе, готовую строку перед записью: так не важно,
//кто и под каким ключом записал ошибку. Номер бота перед двоеточием оставляем — он публичный
//и помогает понять, какой бот писал; секрет — часть после двоеточия.
const TELEGRAM_TOKEN = /(?<!\d)(\d{6,12}):[A-Za-z0-9_-]{30,}/g;

export function redactSecrets(line: string): string {
    return line.replace(TELEGRAM_TOKEN, "$1:***");
}

//Отдельной константой, чтобы тест проверял ту же настройку, что стоит в логгере.
export const logHooks = {streamWrite: redactSecrets};

//Время пишем сами. Полагаться на то, что его проставит journald или docker, нельзя: снаружи
//контейнера этого никто не делает, а лог у нас — единственная история состояния серверов,
//и без времени по нему нельзя восстановить ни динамику, ни момент падения.
export const log = pino({
    level: process.env.LOG_LEVEL ?? defaultLevel,
    base: null,
    errorKey,
    hooks: logHooks,
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