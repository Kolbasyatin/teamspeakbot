import test from "node:test";
import assert from "node:assert/strict";
import {HttpError, type Transformer} from "grammy";
import type {Logger} from "pino";
import {createUnsentRequestRetry, isUnsentRequest} from "./retryUnsentRequests.js";

type Prev = Parameters<Transformer>[0];

//Ошибка ровно в той форме, в какой её отдаёт grammy поверх node-fetch: HttpError, внутри FetchError
//с адресом запроса в тексте и системным кодом.
function networkError(method: string, reason: string, code?: string): HttpError {
    const cause = Object.assign(
        new Error(`request to https://api.telegram.org/bot123456:${"x".repeat(35)}/${method} failed, reason: ${reason}`),
        {name: "FetchError", type: "system", ...(code === undefined ? {} : {code, errno: code})},
    );

    return new HttpError(`Network request for '${method}' failed!`, cause);
}

//Из прод-лога 2026-11-07: соединение через прокси закрылось посреди TLS-рукопожатия.
const tlsReset = (method = "sendMessage"): HttpError => networkError(
    method,
    "Client network socket disconnected before secure TLS connection was established",
    "ECONNRESET",
);

const okResponse = {ok: true, result: true};

//prev, который по очереди отдаёт заготовленные исходы: ошибку бросает, ответ возвращает.
function scriptedPrev(...outcomes: unknown[]): Prev & {calls: string[]} {
    const calls: string[] = [];
    const prev = (async (method: string) => {
        calls.push(method);
        const outcome = outcomes.shift();
        if (outcome instanceof Error) {
            throw outcome;
        }
        return outcome;
    }) as unknown as Prev & {calls: string[]};
    prev.calls = calls;
    return prev;
}

function recordingLogger(): Logger & {infos: Record<string, unknown>[]} {
    const infos: Record<string, unknown>[] = [];
    return {
        infos,
        info: (fields: Record<string, unknown>) => infos.push(fields),
    } as unknown as Logger & {infos: Record<string, unknown>[]};
}

function retry(logger: Logger = recordingLogger()): {transformer: Transformer; pauses: number[]} {
    const pauses: number[] = [];
    const transformer = createUnsentRequestRetry(logger, [500, 1_500], async ms => {
        pauses.push(ms);
    });
    return {transformer, pauses};
}

async function call(transformer: Transformer, prev: Prev, method = "sendMessage", signal?: AbortSignal): Promise<unknown> {
    //grammy типизирует signal своим полифиллом abort-controller; у настоящего AbortSignal тот же контракт.
    return transformer(prev, method as never, {chat_id: 42, text: "x"} as never, signal as Parameters<Transformer>[3]);
}

test("обрыв до TLS-рукопожатия повторяется, и сообщение уходит со второй попытки", async () => {
    const logger = recordingLogger();
    const {transformer, pauses} = retry(logger);
    const prev = scriptedPrev(tlsReset(), okResponse);

    assert.deepEqual(await call(transformer, prev), okResponse);

    assert.deepEqual(prev.calls, ["sendMessage", "sendMessage"]);
    assert.deepEqual(pauses, [500]);
    assert.deepEqual(logger.infos, [{method: "sendMessage", retries: 1}]);
});

test("ответ на кнопку повторяется так же — это его и теряли в проде", async () => {
    const {transformer} = retry();
    const prev = scriptedPrev(tlsReset("answerCallbackQuery"), okResponse);

    assert.deepEqual(await call(transformer, prev, "answerCallbackQuery"), okResponse);
    assert.equal(prev.calls.length, 2);
});

test("канал лежит: после двух повторов отдаётся исходная ошибка", async () => {
    const {transformer, pauses} = retry();
    const last = tlsReset();
    const prev = scriptedPrev(tlsReset(), tlsReset(), last);

    await assert.rejects(call(transformer, prev), error => error === last);
    assert.equal(prev.calls.length, 3);
    assert.deepEqual(pauses, [500, 1_500]);
});

test("обрыв, после которого непонятно, дошёл ли запрос, не повторяется — иначе дубль в чате", async () => {
    const {transformer, pauses} = retry();
    const hangUp = networkError("sendMessage", "socket hang up", "ECONNRESET");
    const prev = scriptedPrev(hangUp, okResponse);

    await assert.rejects(call(transformer, prev), error => error === hangUp);
    assert.equal(prev.calls.length, 1);
    assert.deepEqual(pauses, []);
});

test("getUpdates не повторяем: это делает цикл grammy, и watchdog считает его отказы", async () => {
    const {transformer} = retry();
    const prev = scriptedPrev(tlsReset("getUpdates"), okResponse);

    await assert.rejects(call(transformer, prev, "getUpdates"));
    assert.equal(prev.calls.length, 1);
});

test("отменённый вызов не повторяем", async () => {
    const {transformer} = retry();
    const controller = new AbortController();
    controller.abort();
    const prev = scriptedPrev(tlsReset(), okResponse);

    await assert.rejects(call(transformer, prev, "sendMessage", controller.signal));
    assert.equal(prev.calls.length, 1);
});

test("ошибка Telegram (ok: false) — не исключение и не повторяется", async () => {
    const {transformer} = retry();
    const refused = {ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user"};
    const prev = scriptedPrev(refused);

    assert.deepEqual(await call(transformer, prev), refused);
    assert.equal(prev.calls.length, 1);
});

test("«запрос не ушёл»: отказ подключения, DNS, прокси и TLS — да; прочее — нет", () => {
    assert.equal(isUnsentRequest(tlsReset()), true);
    assert.equal(isUnsentRequest(networkError("sendMessage", "connect ECONNREFUSED 172.17.0.1:10809", "ECONNREFUSED")), true);
    assert.equal(isUnsentRequest(networkError("sendMessage", "getaddrinfo EAI_AGAIN api.telegram.org", "EAI_AGAIN")), true);
    assert.equal(isUnsentRequest(networkError("sendMessage", "Socks5 proxy rejected connection - Failure")), true);
    assert.equal(isUnsentRequest(networkError("sendMessage", "Proxy connection timed out")), true);

    assert.equal(isUnsentRequest(networkError("sendMessage", "socket hang up", "ECONNRESET")), false);
    assert.equal(isUnsentRequest(networkError("sendMessage", "read ETIMEDOUT", "ETIMEDOUT")), false);
    assert.equal(isUnsentRequest(new Error("before secure TLS connection was established")), false);
    assert.equal(isUnsentRequest(new HttpError("Network request for 'sendMessage' failed!", "строка, а не Error")), false);
});
