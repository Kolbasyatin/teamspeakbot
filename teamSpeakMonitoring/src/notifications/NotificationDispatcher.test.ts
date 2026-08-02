import test from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {NotificationDispatcher} from "./NotificationDispatcher.js";
import {
    subscribe,
    type NotificationEvent,
    type NotificationEventOf,
    type NotificationEventType,
    type Notifier,
} from "./events.js";
import {snapshotFixture} from "../test/serverFixtures.js";

//Эти тесты стали возможны только после итерации 2: до неё конструктор диспетчера сам создавал
//grammy Bot и читал глобальный конфиг, поэтому изолированно он не поднимался вообще.

const stateUpdated: NotificationEvent = {
    type: "serverStateUpdated",
    snapshots: [snapshotFixture({id: 1, name: "Test server", status: "online", players: 10})],
};

const serverOnline: NotificationEvent = {
    type: "serverOnline",
    snapshot: snapshotFixture({name: "Test server", status: "online"}),
};

interface RecordingNotifier<TType extends NotificationEventType> extends Notifier<TType> {
    received: NotificationEventOf<TType>[];
}

function createNotifier<TType extends NotificationEventType>(
    options: {failWith?: Error} = {},
): RecordingNotifier<TType> {
    return {
        received: [],
        async notify(event: NotificationEventOf<TType>): Promise<void> {
            this.received.push(event);
            if (options.failWith) {
                throw options.failWith;
            }
        },
    } as RecordingNotifier<TType>;
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

test("событие уходит только тем нотифаерам, что подписаны на его тип", async () => {
    const onView = createNotifier<"serverStateUpdated">();
    const onOnline = createNotifier<"serverOnline">();
    const dispatcher = new NotificationDispatcher(
        [
            subscribe("serverStateUpdated", "view", onView),
            subscribe("serverOnline", "online", onOnline),
        ],
        createLogger().logger,
    );

    await dispatcher.notify(stateUpdated);

    assert.deepEqual(onView.received, [stateUpdated]);
    assert.deepEqual(onOnline.received, [], "не подписанный на этот тип нотифаер не вызывается");
});

test("все нотифаеры одного события вызываются", async () => {
    const first = createNotifier<"serverStateUpdated">();
    const second = createNotifier<"serverStateUpdated">();
    const dispatcher = new NotificationDispatcher(
        [
            subscribe("serverStateUpdated", "first", first),
            subscribe("serverStateUpdated", "second", second),
        ],
        createLogger().logger,
    );

    await dispatcher.notify(stateUpdated);

    assert.equal(first.received.length, 1);
    assert.equal(second.received.length, 1);
});

test("событие без подписчиков не приводит к ошибке", async () => {
    const dispatcher = new NotificationDispatcher([], createLogger().logger);

    await dispatcher.notify(serverOnline);
});

test("отказ одного нотифаера не мешает остальным", async () => {
    const failing = createNotifier<"serverStateUpdated">({failWith: new Error("канал недоступен")});
    const healthy = createNotifier<"serverStateUpdated">();
    const dispatcher = new NotificationDispatcher(
        [
            subscribe("serverStateUpdated", "failing", failing),
            subscribe("serverStateUpdated", "healthy", healthy),
        ],
        createLogger().logger,
    );

    await dispatcher.notify(stateUpdated);

    assert.equal(healthy.received.length, 1, "исправный канал получил событие");
});

test("отказ нотифаера логируется с его именем и типом события", async () => {
    //До итерации 2 отказ гасился allSettled и в лог попадал только бесполезный handlerIndex.
    const {logger, warnings} = createLogger();
    const failure = new Error("канал недоступен");
    const dispatcher = new NotificationDispatcher(
        [subscribe("serverOnline", "telegram", createNotifier<"serverOnline">({failWith: failure}))],
        logger,
    );

    await dispatcher.notify(serverOnline);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.message, "Notification delivery failed");
    assert.equal(warnings[0]?.context.notifier, "telegram");
    assert.equal(warnings[0]?.context.event, "serverOnline");
    assert.equal(warnings[0]?.context.error, failure, "в лог попадает сама ошибка, а не её индекс");
});

test("успешная доставка ничего не логирует", async () => {
    const {logger, warnings} = createLogger();
    const dispatcher = new NotificationDispatcher(
        [subscribe("serverStateUpdated", "log", createNotifier<"serverStateUpdated">())],
        logger,
    );

    await dispatcher.notify(stateUpdated);

    assert.deepEqual(warnings, []);
});

test("нотифаер получает уже суженное событие, без проверки типа внутри", async () => {
    //Итерация 5a: notify типизирован под свой тип события, поэтому event.snapshot доступен
    //без guard'а. Раньше каждый нотифаер начинался с if (event.type !== "...") return.
    let receivedName: string | undefined;
    const notifier: Notifier<"serverOnline"> = {
        async notify(event: NotificationEventOf<"serverOnline">): Promise<void> {
            receivedName = event.snapshot.config.name;
        },
    };
    const dispatcher = new NotificationDispatcher(
        [subscribe("serverOnline", "telegram", notifier)],
        createLogger().logger,
    );

    await dispatcher.notify(serverOnline);

    assert.equal(receivedName, "Test server");
});
