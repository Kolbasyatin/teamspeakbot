import test from "node:test";
import assert from "node:assert/strict";
import {PerSubscriberNotifier, type SubscriberSource} from "./PerSubscriberNotifier.js";
import {ChangesOnlyNotifier} from "./ChangesOnlyNotifier.js";
import type {NotificationEventOf, Notifier} from "./events.js";
import type {ServerProbeSnapshot, ServerStatus} from "../monitoring/ServerProbe.js";
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

//Подписчики в памяти: репозиторий здесь не нужен, вопрос к нему всего один.
function subscribers(byServer: Record<number, number[]>): SubscriberSource {
    return {
        findSubscriberChatIds: (serverId: number): Promise<number[]> =>
            Promise.resolve(byServer[serverId] ?? []),
    };
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
        notify(event: NotificationEventOf<StatusEvent>): Promise<void> {
            if (failWith) {
                const error = failWith;
                failWith = undefined;
                return Promise.reject(error);
            }

            this.sent.push(`${event.snapshot.config.id}:${event.type}`);
            return Promise.resolve();
        },
    };
}

test("событие уходит каждому подписчику сервера", async () => {
    const byChat = new Map<number, RecordingNotifier>();
    const notifier = new PerSubscriberNotifier<StatusEvent>(
        subscribers({1: [100, 200]}),
        event => event.snapshot.config.id,
        chatId => {
            const recording = createRecording();
            byChat.set(chatId, recording);
            return recording;
        },
    );

    await notifier.notify(statusEvent(1, "serverOnline"));

    assert.deepEqual(byChat.get(100)?.sent, ["1:serverOnline"]);
    assert.deepEqual(byChat.get(200)?.sent, ["1:serverOnline"]);
});

test("без подписчиков не доставляется никому", async () => {
    let created = 0;
    const notifier = new PerSubscriberNotifier<StatusEvent>(
        subscribers({}),
        event => event.snapshot.config.id,
        () => {
            created += 1;
            return createRecording();
        },
    );

    await notifier.notify(statusEvent(1, "serverOnline"));

    assert.equal(created, 0);
});

test("нотифаер чата создаётся один раз и переиспользуется", async () => {
    //Ради этого всё и затевалось: внутри стоит дедупликация, и её память обязана пережить событие.
    //Создавай мы цепочку заново на каждое событие — память сбрасывалась бы, и «is online»
    //уходило бы после каждого опроса.
    let created = 0;
    const notifier = new PerSubscriberNotifier<StatusEvent>(
        subscribers({1: [100]}),
        event => event.snapshot.config.id,
        () => {
            created += 1;
            return createRecording();
        },
    );

    await notifier.notify(statusEvent(1, "serverOnline"));
    await notifier.notify(statusEvent(1, "serverOffline"));

    assert.equal(created, 1);
});

test("память дедупликации у каждого подписчика своя", async () => {
    //Главный довод в пользу «рассылка снаружи, дедупликация внутри». При обратном порядке отказ
    //одного адресата откатывал бы общий ключ, и повтор ушёл бы ВСЕМ.
    const byChat = new Map<number, RecordingNotifier>();
    const notifier = new PerSubscriberNotifier<StatusEvent>(
        subscribers({1: [100, 200]}),
        event => event.snapshot.config.id,
        chatId => {
            const recording = createRecording();
            byChat.set(chatId, recording);
            return new ChangesOnlyNotifier(
                recording,
                event => String(event.snapshot.config.id),
                event => event.type,
            );
        },
    );

    //Первая доставка: 100 принял, 200 отказал.
    await notifier.notify(statusEvent(1, "serverOnline"));
    byChat.get(200)?.failNext(new Error("Telegram недоступен"));
    await assert.rejects(() => notifier.notify(statusEvent(1, "serverOffline")));

    //Повтор того же события: 100 молчит — ему уже доставлено, 200 получает свой повтор.
    await notifier.notify(statusEvent(1, "serverOffline"));

    assert.deepEqual(byChat.get(100)?.sent, ["1:serverOnline", "1:serverOffline"]);
    assert.deepEqual(byChat.get(200)?.sent, ["1:serverOnline", "1:serverOffline"]);
});

test("отказ одному не мешает доставке остальным, но виден наружу", async () => {
    //Наружу — потому что его логирует NotificationDispatcher; молчаливая потеря доставки
    //это ровно то, что чинили итерацией 8.
    const byChat = new Map<number, RecordingNotifier>();
    const notifier = new PerSubscriberNotifier<StatusEvent>(
        subscribers({1: [100, 200]}),
        event => event.snapshot.config.id,
        chatId => {
            const recording = createRecording();
            byChat.set(chatId, recording);
            return recording;
        },
    );

    await notifier.notify(statusEvent(1, "serverOnline"));
    byChat.get(100)?.failNext(new Error("Telegram недоступен"));

    await assert.rejects(() => notifier.notify(statusEvent(1, "serverOffline")));

    assert.deepEqual(byChat.get(200)?.sent, ["1:serverOnline", "1:serverOffline"]);
});

test("подписчики читаются на каждое событие", async () => {
    //Подписка появилась между событиями — второе обязано до неё доехать без перезапуска.
    const byServer: Record<number, number[]> = {1: []};
    const byChat = new Map<number, RecordingNotifier>();
    const notifier = new PerSubscriberNotifier<StatusEvent>(
        {findSubscriberChatIds: (serverId: number): Promise<number[]> => Promise.resolve(byServer[serverId] ?? [])},
        event => event.snapshot.config.id,
        chatId => {
            const recording = createRecording();
            byChat.set(chatId, recording);
            return recording;
        },
    );

    await notifier.notify(statusEvent(1, "serverOnline"));
    byServer[1] = [100];
    await notifier.notify(statusEvent(1, "serverOffline"));

    assert.deepEqual(byChat.get(100)?.sent, ["1:serverOffline"]);
});
