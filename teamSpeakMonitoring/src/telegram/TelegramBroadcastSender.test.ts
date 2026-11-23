import test from "node:test";
import assert from "node:assert/strict";
import {GrammyError, HttpError} from "grammy";
import {TelegramBroadcastSender, type BroadcastTransport} from "./TelegramBroadcastSender.js";

function apiError(code: number, description: string, retryAfter?: number): GrammyError {
    return new GrammyError(
        `Call to 'copyMessage' failed! (${code}: ${description})`,
        {ok: false, error_code: code, description, ...(retryAfter === undefined ? {} : {parameters: {retry_after: retryAfter}})},
        "copyMessage",
        {},
    );
}

function transport(failures: unknown[]): BroadcastTransport & {calls: string[]} {
    const calls: string[] = [];

    return {
        calls,
        send: async (chatId, html) => {
            calls.push(`send ${chatId} ${html}`);
            const failure = failures.shift();
            if (failure) {
                throw failure;
            }
        },
        copy: async (chatId, fromChatId, messageId) => {
            calls.push(`copy ${chatId} ${fromChatId}/${messageId}`);
            const failure = failures.shift();
            if (failure) {
                throw failure;
            }
        },
    };
}

const COPY = {kind: "copy", fromChatId: 1, messageId: 42} as const;

test("копия сообщения уходит copyMessage, текст — экранированным", async () => {
    const fake = transport([]);
    const sender = new TelegramBroadcastSender(fake);

    assert.deepEqual(await sender.deliver(555, COPY), {status: "delivered"});
    assert.deepEqual(await sender.deliver(555, {kind: "text", text: "<b>не разметка</b>"}), {status: "delivered"});
    assert.deepEqual(fake.calls, ["copy 555 1/42", "send 555 &lt;b&gt;не разметка&lt;/b&gt;"]);
});

test("заблокировал бота, выгнал из группы, чата нет — недоступен насовсем", async () => {
    for (const error of [
        apiError(403, "Forbidden: bot was blocked by the user"),
        apiError(403, "Forbidden: bot was kicked from the supergroup chat"),
        apiError(400, "Bad Request: chat not found"),
    ]) {
        const outcome = await new TelegramBroadcastSender(transport([error])).deliver(555, COPY);
        assert.equal(outcome.status, "blocked", error.description);
    }
});

test("429: ждём сколько сказали и пробуем ещё раз — ровно один", async () => {
    const pauses: number[] = [];
    const fake = transport([apiError(429, "Too Many Requests: retry after 3", 3)]);
    const sender = new TelegramBroadcastSender(fake, async ms => {
        pauses.push(ms);
    });

    assert.deepEqual(await sender.deliver(555, COPY), {status: "delivered"});
    assert.deepEqual(pauses, [3_000]);
    assert.equal(fake.calls.length, 2);

    const twice = new TelegramBroadcastSender(transport([apiError(429, "Too Many Requests", 1), apiError(429, "Too Many Requests", 1)]), async () => undefined);
    assert.equal((await twice.deliver(555, COPY)).status, "failed");
});

test("прочие ошибки и сеть — разовый сбой, не «недоступен»", async () => {
    const badRequest = await new TelegramBroadcastSender(transport([apiError(400, "Bad Request: message to copy not found")])).deliver(555, COPY);
    const network = await new TelegramBroadcastSender(transport([new HttpError("Network request for 'copyMessage' failed!", new Error("ECONNRESET"))])).deliver(555, COPY);

    assert.deepEqual(badRequest, {status: "failed", error: "400: Bad Request: message to copy not found"});
    assert.equal(network.status, "failed");
});
