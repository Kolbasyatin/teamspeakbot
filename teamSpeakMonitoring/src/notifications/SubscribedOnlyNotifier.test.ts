import test from "node:test";
import assert from "node:assert/strict";
import {SubscribedOnlyNotifier, type StateEventType} from "./SubscribedOnlyNotifier.js";
import {ChangesOnlyNotifier} from "./ChangesOnlyNotifier.js";
import type {NotificationEventOf, Notifier} from "./events.js";
import {snapshotFixture} from "../test/serverFixtures.js";

interface RecordingNotifier extends Notifier<StateEventType> {
    received: NotificationEventOf<StateEventType>[];
}

function createRecording(): RecordingNotifier {
    return {
        received: [],
        notify(event: NotificationEventOf<StateEventType>): Promise<void> {
            this.received.push(event);
            return Promise.resolve();
        },
    };
}

function stateEvent(ids: number[]): NotificationEventOf<StateEventType> {
    return {type: "serverStateUpdated", snapshots: ids.map(id => snapshotFixture({id}))};
}

function receivedIds(recording: RecordingNotifier, index = 0): number[] {
    return (recording.received[index]?.snapshots ?? []).map(snapshot => snapshot.config.id);
}

test("до канала доезжают только подписанные серверы", async () => {
    const recording = createRecording();
    const notifier = new SubscribedOnlyNotifier(recording, () => new Set([1, 3]));

    await notifier.notify(stateEvent([1, 2, 3]));

    assert.deepEqual(receivedIds(recording), [1, 3]);
});

test("тип события сохраняется", async () => {
    //Обёртка подменяет только snapshots: republished обязан остаться republished, иначе он пройдёт
    //не по тому пути доставки.
    const recording = createRecording();
    const notifier = new SubscribedOnlyNotifier(recording, () => new Set([1]));

    await notifier.notify({type: "serverStateRepublished", snapshots: [snapshotFixture({id: 1})]});

    assert.equal(recording.received[0]?.type, "serverStateRepublished");
});

test("пустой набор даёт пустое табло, а не пропуск доставки", async () => {
    //Молчать нельзя: если подписок не осталось, описание обязано опустеть, а не замереть
    //на последнем состоянии.
    const recording = createRecording();
    const notifier = new SubscribedOnlyNotifier(recording, () => new Set());

    await notifier.notify(stateEvent([1, 2]));

    assert.equal(recording.received.length, 1);
    assert.deepEqual(receivedIds(recording), []);
});

test("набор перечитывается на каждое событие", async () => {
    //Он обновляется при пересборке списка опроса, и обёртка обязана увидеть свежий без пересборки
    //самих подписок на события.
    let allowed = new Set([1]);
    const recording = createRecording();
    const notifier = new SubscribedOnlyNotifier(recording, () => allowed);

    await notifier.notify(stateEvent([1, 2]));
    allowed = new Set([2]);
    await notifier.notify(stateEvent([1, 2]));

    assert.deepEqual(receivedIds(recording, 0), [1]);
    assert.deepEqual(receivedIds(recording, 1), [2]);
});

test("чужой сервер не будит дедупликацию табло", async () => {
    //Ради этого фильтр и стоит СНАРУЖИ ChangesOnlyNotifier. Поставь его внутрь — ключ считался бы
    //по всем снапшотам, и изменение на чужом сервере переписывало бы описание в TeamSpeak.
    const recording = createRecording();
    const notifier = new SubscribedOnlyNotifier(
        new ChangesOnlyNotifier(
            recording,
            () => "channelDescription",
            //Ключ как в main.ts: то, что увидит человек. Здесь — состав и статусы видимых серверов.
            event => event.snapshots.map(snapshot => `${snapshot.config.id}:${snapshot.status}`).join(),
        ),
        () => new Set([1]),
    );

    await notifier.notify({
        type: "serverStateUpdated",
        snapshots: [snapshotFixture({id: 1, status: "online"}), snapshotFixture({id: 2, status: "online"})],
    });
    //Меняется только чужой сервер.
    await notifier.notify({
        type: "serverStateUpdated",
        snapshots: [snapshotFixture({id: 1, status: "online"}), snapshotFixture({id: 2, status: "offline"})],
    });

    assert.equal(recording.received.length, 1);
});
