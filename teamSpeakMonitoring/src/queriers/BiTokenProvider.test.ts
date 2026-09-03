import test, {mock} from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {BiTokenProvider} from "./BiTokenProvider.js";

//Подменяется глобальный fetch: проверяется кэш, слияние параллельных запросов и поведение
//при отказе соседа, а не сам HTTP.

function createLogger(): Logger & {warnings: unknown[]; infos: unknown[]} {
    const warnings: unknown[] = [];
    const infos: unknown[] = [];

    return {
        warnings,
        infos,
        debug: () => {},
        info: (payload: unknown) => infos.push(payload),
        warn: (payload: unknown) => warnings.push(payload),
        error: () => {},
    } as unknown as Logger & {warnings: unknown[]; infos: unknown[]};
}

//Ответы соседа по очереди: каждый вызов fetch снимает следующий. Возвращает счётчик вызовов.
function stubFetch(responses: Array<{status?: number; body?: unknown} | Error>): {calls: number} {
    const counter = {calls: 0};

    mock.method(globalThis, "fetch", async () => {
        const response = responses[counter.calls] ?? responses.at(-1);

        counter.calls += 1;

        if (response instanceof Error) {
            throw response;
        }

        const status = response?.status ?? 200;

        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => response?.body,
        } as Response;
    });

    return counter;
}

const START = Date.parse("2026-09-03T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function tokenBody(accessToken: string, expiresAt = START + HOUR): unknown {
    return {accessToken, expiresAt: new Date(expiresAt).toISOString()};
}

function provider(now: {value: number}, logger = createLogger(), url = "http://tokens/token"): BiTokenProvider {
    return new BiTokenProvider({url, timeoutMs: 1000, refreshLeadMs: 60_000}, logger, () => now.value);
}

test.afterEach(() => {
    mock.restoreAll();
});

test("токен читается из ответа соседа", async () => {
    stubFetch([{body: tokenBody("jwt-1")}]);

    assert.equal(await provider({value: START}).getToken(), "jwt-1");
});

test("пока токен свежий, к соседу не ходим", async () => {
    const fetches = stubFetch([{body: tokenBody("jwt-1")}]);
    const now = {value: START};
    const tokens = provider(now);

    await tokens.getToken();
    now.value = START + HOUR - 5 * 60 * 1000;
    await tokens.getToken();
    await tokens.getToken();

    assert.equal(fetches.calls, 1);
});

test("незадолго до истечения токен считается протухшим и перезапрашивается", async () => {
    const fetches = stubFetch([{body: tokenBody("jwt-1")}, {body: tokenBody("jwt-2", START + 2 * HOUR)}]);
    const now = {value: START};
    const tokens = provider(now);

    assert.equal(await tokens.getToken(), "jwt-1");
    //refreshLeadMs = 60 с: за полминуты до expiresAt кэш уже не годится.
    now.value = START + HOUR - 30_000;
    assert.equal(await tokens.getToken(), "jwt-2");
    assert.equal(fetches.calls, 2);
});

test("параллельные запросы делят один fetch", async () => {
    //Десять серверов на одном тике не должны десять раз спрашивать соседа.
    const fetches = stubFetch([{body: tokenBody("jwt-1")}]);
    const tokens = provider({value: START});

    const results = await Promise.all([tokens.getToken(), tokens.getToken(), tokens.getToken()]);

    assert.deepEqual(results, ["jwt-1", "jwt-1", "jwt-1"]);
    assert.equal(fetches.calls, 1);
});

test("invalidate сбрасывает кэш — следующий запрос идёт к соседу", async () => {
    const fetches = stubFetch([{body: tokenBody("jwt-1")}, {body: tokenBody("jwt-2")}]);
    const tokens = provider({value: START});

    await tokens.getToken();
    tokens.invalidate();

    assert.equal(await tokens.getToken(), "jwt-2");
    assert.equal(fetches.calls, 2);
});

test("404 у соседа — токена нет, warn один раз на эпизод", async () => {
    stubFetch([{status: 404}]);
    const logger = createLogger();
    const tokens = provider({value: START}, logger);

    assert.equal(await tokens.getToken(), undefined);
    assert.equal(await tokens.getToken(), undefined);
    assert.equal(logger.warnings.length, 1, "повтор той же беды в лог не пишется");
});

test("восстановление после отказа пишется в лог info", async () => {
    stubFetch([new Error("ECONNREFUSED"), {body: tokenBody("jwt-1")}]);
    const logger = createLogger();
    const tokens = provider({value: START}, logger);

    assert.equal(await tokens.getToken(), undefined);
    assert.equal(await tokens.getToken(), "jwt-1");
    assert.equal(logger.warnings.length, 1);
    assert.equal(logger.infos.length, 1);
});

test("сломанный ответ соседа — это отказ, а не почти токен", async () => {
    stubFetch([{body: {accessToken: "", expiresAt: "не дата"}}]);

    assert.equal(await provider({value: START}).getToken(), undefined);
});

test("пустой URL выключает источник токенов без единого запроса", async () => {
    const fetches = stubFetch([{body: tokenBody("jwt-1")}]);
    const logger = createLogger();

    assert.equal(await provider({value: START}, logger, "").getToken(), undefined);
    assert.equal(fetches.calls, 0);
    assert.equal(logger.infos.length, 1, "о выключении сказано один раз, при создании");
});
