import test from "node:test";
import assert from "node:assert/strict";
import type {Context, Transformer} from "grammy";
import type {Update} from "grammy/types";
import type {Logger} from "pino";
import {createApiLogger, createUpdateDeadline, createUpdateLogger, describeUpdate, PollingWatchdog} from "./TelegramDiagnostics.js";

interface LogLine {
    level: string;
    fields: Record<string, unknown>;
    message: string;
}

//Логгер, который запоминает строки: проверяется именно то, что попадёт в прод-лог.
function recordingLogger(): Logger & {lines: LogLine[]; at: (level: string) => LogLine[]} {
    const lines: LogLine[] = [];
    const write = (level: string) => (fields: Record<string, unknown> | string, message?: string): void => {
        lines.push(typeof fields === "string"
            ? {level, fields: {}, message: fields}
            : {level, fields, message: message ?? ""});
    };

    return {
        lines,
        at: (level: string) => lines.filter(line => line.level === level),
        debug: write("debug"),
        info: write("info"),
        warn: write("warn"),
        error: write("error"),
    } as unknown as Logger & {lines: LogLine[]; at: (level: string) => LogLine[]};
}

const commandUpdate = {
    update_id: 7,
    message: {message_id: 1, date: 0, chat: {id: -100, type: "group", title: "g"}, text: "/who@tsbot лишнее"},
} as unknown as Update;

test("апдейт описывается без текста сообщения: только команда и чат", () => {
    assert.deepEqual(describeUpdate(commandUpdate), {updateId: 7, kind: "message", chatId: -100, command: "/who@tsbot"});

    const plain = {update_id: 8, message: {message_id: 1, date: 0, chat: {id: 5, type: "private"}, text: "личное"}} as unknown as Update;
    assert.deepEqual(describeUpdate(plain), {updateId: 8, kind: "message", chatId: 5});

    const callback = {
        update_id: 9,
        callback_query: {id: "q", data: "k:s:1", chat_instance: "x", from: {id: 5}, message: {chat: {id: 5}}},
    } as unknown as Update;
    assert.deepEqual(describeUpdate(callback), {updateId: 9, kind: "callback_query", chatId: 5, callbackData: "k:s:1"});
});

test("живой цикл не вызывает тревоги", () => {
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger, 90_000, 600_000);

    watchdog.started(0);
    //long poll по 30 с, как в grammy
    for (let t = 0; t < 300_000; t += 30_000) {
        watchdog.pollStarted(t);
        watchdog.pollSucceeded(t + 30_000, 0);
        watchdog.check(t + 30_000);
    }

    assert.deepEqual(logger.at("error"), []);
});

test("повисший обработчик: тревога один раз и с указанием апдейта", () => {
    //Тот самый сценарий зависания: getUpdates вернул апдейт, обработчик не завершается,
    //следующий getUpdates не уходит.
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger, 90_000, 600_000);

    watchdog.started(0);
    watchdog.pollStarted(0);
    watchdog.pollSucceeded(1_000, 1);
    watchdog.updateStarted(1_000, describeUpdate(commandUpdate));

    watchdog.check(60_000);
    assert.deepEqual(logger.at("error"), [], "до порога тревоги нет");

    watchdog.check(91_000);
    watchdog.check(200_000);

    const errors = logger.at("error");
    assert.equal(errors.length, 1, "эпизод сообщается один раз, а не каждой проверкой");
    assert.equal(errors[0]?.fields["reason"], "обработчик апдейта не завершается");
    assert.deepEqual(errors[0]?.fields["hangingUpdates"], [
        {updateId: 7, kind: "message", chatId: -100, command: "/who@tsbot", handlingMs: 90_000},
    ]);
});

test("повисший getUpdates отличается от повисшего обработчика", () => {
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger, 90_000, 600_000);

    watchdog.started(0);
    watchdog.pollStarted(10_000);
    watchdog.check(100_000);

    assert.equal(logger.at("error")[0]?.fields["reason"], "getUpdates не возвращается");
    assert.equal(logger.at("error")[0]?.fields["pollingForMs"], 90_000);
});

test("после восстановления — отметка, и следующий эпизод снова сообщается", () => {
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger, 90_000, 600_000);

    watchdog.started(0);
    watchdog.check(100_000);
    watchdog.pollStarted(150_000);

    assert.equal(logger.at("warn").filter(line => line.message === "Polling Telegram ожил").length, 1);
    assert.equal(logger.at("warn")[0]?.fields["stalledMs"], 150_000);

    watchdog.check(300_000);
    assert.equal(logger.at("error").length, 2);
});

test("серия ошибок getUpdates: warn только на первую, итог — на восстановлении", () => {
    //При отказе сети grammy повторяет каждые 3 с — warn на каждую попытку забил бы лог.
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger, 90_000, 600_000);

    watchdog.started(0);
    for (let attempt = 0; attempt < 5; attempt++) {
        watchdog.pollStarted(attempt * 3_000);
        watchdog.pollFailed(attempt * 3_000 + 100, new Error("ECONNRESET"));
    }
    watchdog.pollStarted(20_000);
    watchdog.pollSucceeded(21_000, 0);

    assert.equal(logger.at("warn").length, 1);
    const recovered = logger.at("info").find(line => line.message === "getUpdates снова проходит");
    assert.equal(recovered?.fields["failedAttempts"], 5);
});

test("сводка на info раз в период со счётчиками, счётчики сбрасываются", () => {
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger, 90_000, 600_000);

    watchdog.started(0);
    watchdog.pollStarted(0);
    watchdog.pollSucceeded(30_000, 2);
    watchdog.pollStarted(30_000);
    watchdog.pollFailed(31_000, new Error("x"));
    watchdog.pollStarted(34_000);
    watchdog.pollSucceeded(64_000, 1);

    watchdog.check(599_000);
    assert.equal(logger.at("info").filter(line => line.message.startsWith("Telegram polling")).length, 0);

    watchdog.check(600_000);
    watchdog.check(1_200_000);
    const summaries = logger.at("info").filter(line => line.message.startsWith("Telegram polling"));

    assert.deepEqual(summaries.map(line => [line.fields["polls"], line.fields["updates"], line.fields["pollErrors"]]), [
        [2, 3, 1],
        [0, 0, 0],
    ]);
});

test("до старта polling тревоги нет", () => {
    //Бот без start() (или до него) не должен считаться зависшим.
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger, 90_000, 600_000);

    watchdog.check(1_000_000);

    assert.deepEqual(logger.lines, []);
});

test("трансформер кормит watchdog результатами getUpdates и пропускает ответ как есть", async () => {
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger, 90_000, 600_000);
    let clock = 0;
    const transformer = createApiLogger(logger, watchdog, () => clock);

    watchdog.started(0);
    const updates = {ok: true, result: [{update_id: 1}, {update_id: 2}]};
    const prev = (async () => {
        clock = 30_000;
        return updates;
    }) as unknown as Parameters<Transformer>[0];

    const response = await transformer(prev, "getUpdates" as never, {} as never);

    assert.equal(response, updates);
    assert.deepEqual(logger.at("debug")[0]?.fields, {updateCount: 2, durationMs: 30_000});
});

test("ошибка Bot API и сетевой отказ видны в логе с методом и чатом", async () => {
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger);
    const transformer = createApiLogger(logger, watchdog, () => 0);

    const refused = (async () => ({ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user"})) as unknown as Parameters<Transformer>[0];
    await transformer(refused, "sendMessage" as never, {chat_id: 42, text: "x"} as never);

    const broken = (async () => {
        throw new Error("socket hang up");
    }) as unknown as Parameters<Transformer>[0];
    await assert.rejects(transformer(broken, "sendMessage" as never, {chat_id: 43, text: "x"} as never), /socket hang up/);

    assert.deepEqual(logger.at("warn").map(line => [line.fields["method"], line.fields["chatId"], line.fields["code"]]), [
        ["sendMessage", 42, 403],
        ["sendMessage", 43, undefined],
    ]);
});

test("middleware отмечает апдейт в работе и снимает отметку, даже если обработчик упал", async () => {
    const logger = recordingLogger();
    const watchdog = new PollingWatchdog(logger, 90_000, 600_000);
    let clock = 0;
    const middleware = createUpdateLogger(logger, watchdog, () => clock);
    const ctx = {update: commandUpdate} as unknown as Context;

    watchdog.started(0);
    await assert.rejects(async () => middleware(ctx, async () => {
        clock = 15_000;
        throw new Error("обработчик упал");
    }));

    //Долгая обработка видна warn'ом, с признаком неудачи.
    const slow = logger.at("warn").find(line => line.message === "Апдейт Telegram обрабатывался долго");
    assert.equal(slow?.fields["durationMs"], 15_000);
    assert.equal(slow?.fields["failed"], true);

    //Отметка снята: при остановке цикла виноватым этот апдейт уже не назовут.
    watchdog.check(200_000);
    assert.equal(logger.at("error")[0]?.fields["reason"], "getUpdates не вызывается");
});

test("дедлайн отпускает цикл, если обработчик повис", async () => {
    //Главное свойство: middleware возвращается, и grammy идёт за следующими апдейтами.
    const logger = recordingLogger();
    const deadline = createUpdateDeadline(logger, 30);
    const ctx = {update: commandUpdate} as unknown as Context;

    await deadline(ctx, () => new Promise<void>(() => undefined));

    const error = logger.at("error")[0];
    assert.equal(error?.fields["command"], "/who@tsbot");
    assert.equal(error?.fields["timeoutMs"], 30);
});

test("быстрый обработчик дедлайн не замечает, его ошибка проходит к bot.catch", async () => {
    const logger = recordingLogger();
    const deadline = createUpdateDeadline(logger, 1_000);
    const ctx = {update: commandUpdate} as unknown as Context;

    await deadline(ctx, async () => undefined);
    await assert.rejects(async () => deadline(ctx, async () => {
        throw new Error("обычная ошибка");
    }), /обычная ошибка/);

    assert.deepEqual(logger.at("error"), []);
});

test("ошибка брошенного обработчика не теряется, а пишется в лог", async () => {
    //bot.catch её уже не увидит: цикл ушёл дальше. Без этого она ушла бы в unhandled rejection.
    const logger = recordingLogger();
    const deadline = createUpdateDeadline(logger, 20);
    const ctx = {update: commandUpdate} as unknown as Context;
    let fail: (error: Error) => void = () => undefined;

    await deadline(ctx, () => new Promise<void>((_, reject) => {
        fail = reject;
    }));
    fail(new Error("TeamSpeak ответил через минуту"));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(logger.at("error").length, 2);
    assert.equal(logger.at("error")[1]?.message, "Обработчик апдейта упал уже после дедлайна");
});
