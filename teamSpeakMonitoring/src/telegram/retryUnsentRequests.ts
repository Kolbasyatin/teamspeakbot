import {HttpError, type Transformer} from "grammy";
import type {Logger} from "pino";

//Повтор вызова Bot API, который ТОЧНО не дошёл до Telegram.
//
//Зачем. Соединение через прокси (TELEGRAM_PROXY_URL) изредка рвётся посреди TLS-рукопожатия:
//в проде 2026-11-07 — два обрыва за час, по 200–350 мс, при том что прокси живой (60 запросов
//подряд без единого отказа). grammy сам повторяет только getUpdates. sendMessage и ответ на кнопку
//пропадали: уведомление о статусе приходило с опозданием до минуты (его повторяет тик StateSync),
//а нажатие кнопки терялось совсем — обработчик падал, человеку приходилось жать ещё раз.
//
//Почему не любой сетевой отказ. Обрыв ПОСЛЕ отправки запроса не говорит, дошёл ли он: Telegram
//мог сообщение принять, а потерялся только ответ. Повтор такого sendMessage — дубль в чате.
//Поэтому повторяем только отказы, при которых байты запроса заведомо не ушли: соединение
//не установилось, прокси не открыл туннель, TLS не договорился. Голый ECONNRESET («socket hang up»)
//сюда не входит — он бывает и после отправки.
//
//getUpdates не трогаем: его повторяет цикл grammy, и watchdog считает эти повторы сам.
//
//Ставится ПОСЛЕ трансформера диагностики, то есть снаружи него: каждая неудачная попытка видна
//в логе своей строкой «Вызов Bot API не прошёл», а итог — строкой «прошёл после повтора».
//Так по логу видно, как часто рвётся канал до Telegram, даже когда повтор всё спас.

//Паузы перед повторами. Две попытки сверх первой: обрывы одиночные, и третья неудача подряд
//говорит уже не о сбое, а о том, что канал лежит, — ждать дольше значит держать ответ на кнопку.
const DEFAULT_DELAYS_MS: readonly number[] = [500, 1_500];

//Коды ошибок, при которых соединение не было установлено: в отказ упёрлось подключение (ECONNREFUSED)
//или разрешение имени (ENOTFOUND, EAI_AGAIN). Запроса в таком соединении не было.
const UNSENT_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

//Тексты отказов до отправки, у которых нет своего кода.
const UNSENT_MESSAGES: readonly RegExp[] = [
    //Node: соединение закрылось до конца TLS-рукопожатия. Код у него ECONNRESET — общий с обрывом
    //после отправки, поэтому отличаем по тексту. Ровно этот случай и был в проде.
    /before secure TLS connection was established/,
    //socks-proxy-agent: прокси не открыл туннель или не ответил на рукопожатие SOCKS.
    /Socks5? proxy rejected connection/i,
    /Proxy connection timed out/i,
];

export function isUnsentRequest(error: unknown): boolean {
    //Сетевой отказ grammy заворачивает в HttpError, исходная ошибка fetch — в поле error.
    //Ответ Telegram с ошибкой (ok: false) сюда не попадает вовсе: это не исключение.
    if (!(error instanceof HttpError) || !(error.error instanceof Error)) {
        return false;
    }

    const cause: Error & {code?: unknown} = error.error;

    if (typeof cause.code === "string" && UNSENT_CODES.has(cause.code)) {
        return true;
    }

    return UNSENT_MESSAGES.some(pattern => pattern.test(cause.message));
}

export function createUnsentRequestRetry(
    logger: Logger,
    delaysMs: readonly number[] = DEFAULT_DELAYS_MS,
    sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Transformer {
    return async (prev, method, payload, signal) => {
        if (method === "getUpdates") {
            return prev(method, payload, signal);
        }

        for (let retries = 0; ; retries++) {
            try {
                const response = await prev(method, payload, signal);

                if (retries > 0) {
                    logger.info({method, retries}, "Вызов Bot API прошёл после повтора");
                }

                return response;
            } catch (error) {
                const delayMs = delaysMs[retries];

                //Отменённый вызов не повторяем: его отменил тот, кто ждал ответа.
                if (delayMs === undefined || signal?.aborted === true || !isUnsentRequest(error)) {
                    throw error;
                }

                await sleep(delayMs);
            }
        }
    };
}
