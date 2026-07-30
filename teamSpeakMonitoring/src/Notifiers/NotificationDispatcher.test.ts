import test from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {
    NotificationDispatcher,
    type NotificationEvent,
    type NotificationHandler,
    type NotificationSubscription,
} from "./NotificationDispatcher.js";

//Эти тесты стали возможны только после итерации 2: до неё конструктор диспетчера сам создавал
//grammy Bot и читал глобальный конфиг, поэтому изолированно он не поднимался вообще.

const viewChanged: NotificationEvent = {
    type: "statusViewChanged",
    view: [{id: 1, name: "Test server", status: "online", players: 10, maxPlayers: 64}],
};

const serverOnline: NotificationEvent = {
    type: "serverOnline",
    snapshot: {
        config: {
            id: 1,
            name: "Test server",
            gameAddress: "127.0.0.1:2001",
            query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000},
        },
        status: "online",
        failedChecks: 0,
        info: undefined,
        lastInfo: undefined,
        statusSince: new Date(0),
    },
};

interface RecordingHandler extends NotificationHandler {
    received: NotificationEvent[];
}

function createHandler(options: {failWith?: Error} = {}): RecordingHandler {
    return {
        received: [],
        async notify(event: NotificationEvent): Promise<void> {
            this.received.push(event);
            if (options.failWith) {
                throw options.failWith;
            }
        },
    } as RecordingHandler;
}

function createLogger(): {logger: Logger; warnings: Array<{context: Record<string, unknown>; message: string}>} {
    const warnings: Array<{context: Record<string, unknown>; message: string}> = [];

    const logger = {
        debug: () => {},
        info: () => {},
        error: () => {},
        warn: (context: Record<string, unknown>, message: string) => warnings.push({context, message}),
    } as unknown as Logger;

    return {logger, warnings};
}

function subscribe(event: NotificationSubscription["event"], name: string, handler: NotificationHandler): NotificationSubscription {
    return {event, name, handler};
}

test("событие уходит только тем хендлерам, что подписаны на его тип", async () => {
    const onView = createHandler();
    const onOnline = createHandler();
    const dispatcher = new NotificationDispatcher(
        [subscribe("statusViewChanged", "view", onView), subscribe("serverOnline", "online", onOnline)],
        createLogger().logger,
    );

    await dispatcher.notify(viewChanged);

    assert.deepEqual(onView.received, [viewChanged]);
    assert.deepEqual(onOnline.received, [], "не подписанный на этот тип хендлер не вызывается");
});

test("все хендлеры одного события вызываются", async () => {
    const first = createHandler();
    const second = createHandler();
    const dispatcher = new NotificationDispatcher(
        [subscribe("statusViewChanged", "first", first), subscribe("statusViewChanged", "second", second)],
        createLogger().logger,
    );

    await dispatcher.notify(viewChanged);

    assert.equal(first.received.length, 1);
    assert.equal(second.received.length, 1);
});

test("событие без подписчиков не приводит к ошибке", async () => {
    const dispatcher = new NotificationDispatcher([], createLogger().logger);

    await dispatcher.notify(serverOnline);
});

test("отказ одного хендлера не мешает остальным", async () => {
    const failing = createHandler({failWith: new Error("канал недоступен")});
    const healthy = createHandler();
    const dispatcher = new NotificationDispatcher(
        [subscribe("statusViewChanged", "failing", failing), subscribe("statusViewChanged", "healthy", healthy)],
        createLogger().logger,
    );

    await dispatcher.notify(viewChanged);

    assert.equal(healthy.received.length, 1, "исправный канал получил событие");
});

test("отказ хендлера логируется с его именем и типом события", async () => {
    //До итерации 2 отказ гасился allSettled и в лог попадал только бесполезный handlerIndex.
    const {logger, warnings} = createLogger();
    const failure = new Error("канал недоступен");
    const dispatcher = new NotificationDispatcher(
        [subscribe("serverOnline", "telegram:online", createHandler({failWith: failure}))],
        logger,
    );

    await dispatcher.notify(serverOnline);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.message, "Notification handler failed");
    assert.equal(warnings[0]?.context.handler, "telegram:online");
    assert.equal(warnings[0]?.context.event, "serverOnline");
    assert.equal(warnings[0]?.context.error, failure, "в лог попадает сама ошибка, а не её индекс");
});

test("успешная доставка ничего не логирует", async () => {
    const {logger, warnings} = createLogger();
    const dispatcher = new NotificationDispatcher([subscribe("statusViewChanged", "log", createHandler())], logger);

    await dispatcher.notify(viewChanged);

    assert.deepEqual(warnings, []);
});
