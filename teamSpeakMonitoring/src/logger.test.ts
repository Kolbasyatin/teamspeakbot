import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import {logHooks, redactSecrets} from "./logger.js";

const secret = "AAFakeTokenForTestsOnly_0123456789abc";
const url = `https://api.telegram.org/bot1234567890:${secret}/answerCallbackQuery`;

test("токен в адресе запроса заменяется, номер бота остаётся", () => {
    assert.equal(
        redactSecrets(`request to ${url} failed`),
        "request to https://api.telegram.org/bot1234567890:***/answerCallbackQuery failed",
    );
});

test("обычные строки лога не задеваются: время, id чатов, адреса с портом", () => {
    const line = '{"time":1794057510937,"chatId":-1003738458034,"host":"37.48.253.41:2001","msg":"12:29:06"}';

    assert.equal(redactSecrets(line), line);
});

test("ошибка Telegram в прод-форме уходит в лог без токена — ни в message, ни в stack вложенной ошибки", () => {
    const lines: string[] = [];
    const logger = pino(
        {base: null, errorKey: "error", hooks: logHooks},
        {write: (line: string) => lines.push(line)},
    );

    //Форма из прод-лога 2026-11-07: HttpError grammy, внутри FetchError с адресом запроса.
    const cause = new Error(`request to ${url} failed, reason: Client network socket disconnected`);
    const error = Object.assign(new Error("Network request for 'answerCallbackQuery' failed!"), {error: cause});
    logger.warn({error}, "Вызов Bot API не прошёл");

    assert.equal(lines.length, 1);
    const line = lines[0] ?? "";
    assert.ok(!line.includes(secret), line);
    assert.ok(line.includes("bot1234567890:***"), line);
    //Строка по-прежнему JSON: hook не должен ломать формат лога.
    assert.doesNotThrow(() => JSON.parse(line));
});
