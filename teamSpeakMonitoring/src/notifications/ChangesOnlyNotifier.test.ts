import test from "node:test";
import assert from "node:assert/strict";
import {ChangesOnlyNotifier} from "./ChangesOnlyNotifier.js";
import {StateSync, type CurrentStateSource} from "./StateSync.js";
import {NotificationDispatcher} from "./NotificationDispatcher.js";
import {subscribe, type NotificationEventOf, type Notifier} from "./events.js";
import type {ServerProbeSnapshot, ServerStatus} from "../monitoring/ServerProbe.js";
import type {Logger} from "pino";
import {serverConfigFixture} from "../test/serverFixtures.js";

type StatusEvent = "serverOnline" | "serverOffline";

function snapshot(id: number, status: ServerStatus): ServerProbeSnapshot {
    return {
        config: serverConfigFixture({id}),
        status,
        failedChecks: 0,
        currentInfo: undefined,
        statusSince: new Date(0),
    };
}

function statusEvent(id: number, type: StatusEvent): NotificationEventOf<StatusEvent> {
    return {type, snapshot: snapshot(id, type === "serverOnline" ? "online" : "offline")};
}

function createLogger(): Logger {
    return {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}} as unknown as Logger;
}

//Отдаёт управление event loop, чтобы уже начатые промисы продвинулись.
function flush(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

//Ключи как в main.ts: предмет — сервер, состояние — тип события.
function wrap(inner: Notifier<StatusEvent>): ChangesOnlyNotifier<StatusEvent> {
    return new ChangesOnlyNotifier(
        inner,
        event => String(event.snapshot.config.id),
        event => event.type,
    );
}

interface RecordingNotifier extends Notifier<StatusEvent> {
    sent: string[];
    failNext(error: Error): void;
}

function createRecording(): RecordingNotifier {
    let failWith: Error | undefined;

    return {
        sent: [],
        failNext(error: Error): void {
            failWith = error;
        },
        async notify(event: NotificationEventOf<StatusEvent>): Promise<void> {
            if (failWith) {
                const error = failWith;
                failWith = undefined;
                throw error;
            }

            this.sent.push(`${event.snapshot.config.id}:${event.type}`);
        },
    } as RecordingNotifier;
}

test("первое событие по серверу доставляется", async () => {
    const inner = createRecording();
    const notifier = wrap(inner);

    await notifier.notify(statusEvent(1, "serverOnline"));

    assert.deepEqual(inner.sent, ["1:serverOnline"]);
});

test("повтор того же состояния не доставляется — иначе тик каждую минуту спамил бы канал", async () => {
    const inner = createRecording();
    const notifier = wrap(inner);

    for (let tick = 0; tick < 5; tick++) {
        await notifier.notify(statusEvent(1, "serverOnline"));
    }

    assert.deepEqual(inner.sent, ["1:serverOnline"], "пять тиков — одно сообщение");
});

test("смена состояния доставляется, и обратная смена тоже", async () => {
    const inner = createRecording();
    const notifier = wrap(inner);

    await notifier.notify(statusEvent(1, "serverOnline"));
    await notifier.notify(statusEvent(1, "serverOffline"));
    await notifier.notify(statusEvent(1, "serverOnline"));

    assert.deepEqual(inner.sent, ["1:serverOnline", "1:serverOffline", "1:serverOnline"]);
});

test("серверы независимы: состояние одного не глушит сообщение про другого", async () => {
    const inner = createRecording();
    const notifier = wrap(inner);

    await notifier.notify(statusEvent(1, "serverOnline"));
    await notifier.notify(statusEvent(2, "serverOnline"));

    assert.deepEqual(inner.sent, ["1:serverOnline", "2:serverOnline"]);
});

test("упавшая отправка не запоминается: следующая попытка отправляет заново", async () => {
    //Это и есть починка. Раньше сообщение терялось до следующего падения и подъёма сервера.
    const inner = createRecording();
    const notifier = wrap(inner);

    inner.failNext(new Error("Telegram недоступен"));
    await assert.rejects(notifier.notify(statusEvent(1, "serverOnline")), /Telegram недоступен/);
    assert.deepEqual(inner.sent, []);

    await notifier.notify(statusEvent(1, "serverOnline"));

    assert.deepEqual(inner.sent, ["1:serverOnline"], "повтор ушёл, состояние не считалось доставленным");
});

test("две одновременные доставки одного состояния дают одну отправку", async () => {
    //Тик синхронизации и реальный переход статуса приходят независимо, через void. Если запоминать
    //только после успеха, оба вызова прошли бы проверку до записи — и в канал ушло бы два сообщения.
    //Отпускаем ВСЕ начатые доставки, а не последнюю: иначе при регрессии один промис останется
    //висеть, тест не упадёт, а зависнет и утащит за собой соседние (наступали на это в 5b).
    const unblocks: Array<() => void> = [];
    const sent: string[] = [];
    const inner: Notifier<StatusEvent> = {
        notify: async (event): Promise<void> => {
            await new Promise<void>(resolve => unblocks.push(resolve));
            sent.push(`${event.snapshot.config.id}:${event.type}`);
        },
    };
    const notifier = wrap(inner);

    const first = notifier.notify(statusEvent(1, "serverOnline"));
    await flush();
    const second = notifier.notify(statusEvent(1, "serverOnline"));
    await flush();

    unblocks.forEach(release => release());
    await Promise.all([first, second]);

    assert.deepEqual(sent, ["1:serverOnline"], "второй вызов увидел уже занятое состояние и промолчал");
});

test("сквозной сценарий: упавшая отправка доезжает следующим тиком, дальше тики молчат", async () => {
    const inner = createRecording();
    //Один экземпляр обёртки на оба события — как в main.ts. Почему это важно, см. тест ниже.
    const telegram = wrap(inner);
    const dispatcher = new NotificationDispatcher(
        [
            subscribe("serverOnline", "telegram", telegram),
            subscribe("serverOffline", "telegram", telegram),
        ],
        createLogger(),
    );
    const state: CurrentStateSource = {
        getSnapshot: (): ServerProbeSnapshot[] => [snapshot(1, "online")],
    };
    const stateSync = new StateSync(state, dispatcher);

    //12:00 — сервер поднялся, реальный переход статуса, отправка падает.
    inner.failNext(new Error("Telegram недоступен"));
    await dispatcher.notify(statusEvent(1, "serverOnline"));
    assert.deepEqual(inner.sent, [], "сообщение потеряно");

    //12:01 — тик: доставленного состояния нет, текущее online → расхождение → отправляем.
    await stateSync.publishCurrentState();
    assert.deepEqual(inner.sent, ["1:serverOnline"], "тик доставил потерянное сообщение");

    //12:02 и далее — состояние совпадает с доставленным, канал молчит.
    await stateSync.publishCurrentState();
    await stateSync.publishCurrentState();

    assert.deepEqual(inner.sent, ["1:serverOnline"], "никакого спама: тики молчат");
});

test("оба события обслуживает один экземпляр обёртки, иначе память разъезжается", async () => {
    //Ловушка сборки: подписать на serverOnline и serverOffline две РАЗНЫЕ обёртки. Тогда у каждой
    //своя память, и падение сервера с последующим подъёмом даст только два сообщения вместо трёх —
    //обёртка «online» так и будет считать, что online уже доставлен, хотя между ними был offline.
    const inner = createRecording();
    const telegram = wrap(inner);
    const dispatcher = new NotificationDispatcher(
        [
            subscribe("serverOnline", "telegram", telegram),
            subscribe("serverOffline", "telegram", telegram),
        ],
        createLogger(),
    );

    await dispatcher.notify(statusEvent(1, "serverOnline"));
    await dispatcher.notify(statusEvent(1, "serverOffline"));
    await dispatcher.notify(statusEvent(1, "serverOnline"));

    assert.deepEqual(inner.sent, ["1:serverOnline", "1:serverOffline", "1:serverOnline"]);
});
