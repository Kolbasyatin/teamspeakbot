import test from "node:test";
import assert from "node:assert/strict";
import {StateSync, type CurrentStateSource} from "./StateSync.js";
import {LatestOnlyNotifier} from "./LatestOnlyNotifier.js";
import {ChangesOnlyNotifier} from "./ChangesOnlyNotifier.js";
import {NotificationDispatcher} from "./NotificationDispatcher.js";
import {subscribe, type NotificationEvent, type NotificationEventOf, type Notifier} from "./events.js";
import type {ServerProbeSnapshot, ServerStatus} from "../monitoring/ServerProbe.js";
import type {Logger} from "pino";
import {snapshotFixture} from "../test/serverFixtures.js";

type ViewEvent = "serverStateUpdated" | "serverStateRepublished";

function board(players: number): ServerProbeSnapshot[] {
    return [snapshotFixture({id: 1, name: "Test server", status: "online", players})];
}

function snapshot(id: number, status: ServerStatus): ServerProbeSnapshot {
    return snapshotFixture({id, status});
}

//Источник состояния, который можно менять между тиками: тик обязан брать актуальное,
//а не то, что было на момент сборки.
function createStateSource(
    servers: ServerProbeSnapshot[] = [],
): CurrentStateSource & {servers: ServerProbeSnapshot[]} {
    return {
        servers,
        getSnapshot(): ServerProbeSnapshot[] {
            return this.servers;
        },
    };
}

function createLogger(): Logger {
    return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    } as unknown as Logger;
}

//Тот же управляемый нотифаер, что в LatestOnlyNotifier.test.ts: доставка висит до release().
//Так «TeamSpeak не отвечает» воспроизводится без таймеров и гонок.
interface ControllableNotifier extends Notifier<ViewEvent> {
    delivered: Array<{type: ViewEvent; players: number}>;
    release(): void;
    failNext(error: Error): void;
}

function createControllable(): ControllableNotifier {
    let unblock: (() => void) | undefined;
    let failWith: Error | undefined;

    return {
        delivered: [],
        release(): void {
            unblock?.();
            unblock = undefined;
        },
        failNext(error: Error): void {
            failWith = error;
        },
        async notify(event: NotificationEventOf<ViewEvent>): Promise<void> {
            await new Promise<void>(resolve => {
                unblock = resolve;
            });

            if (failWith) {
                const error = failWith;
                failWith = undefined;
                throw error;
            }

            this.delivered.push({
                type: event.type,
                players: event.snapshots[0]?.currentInfo?.players ?? -1,
            });
        },
    } as ControllableNotifier;
}

function flush(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

test("публикует текущее состояние событием serverStateRepublished", async () => {
    const published: NotificationEvent[] = [];
    const servers = board(12);
    const stateSync = new StateSync(createStateSource(servers), {
        notify: async (event): Promise<void> => {
            published.push(event);
        },
    });

    await stateSync.publishCurrentState();

    assert.deepEqual(published, [
        {type: "serverStateRepublished", snapshots: servers},
        {type: "serverOnline", snapshot: servers[0]},
    ]);
});

test("каждый тик берёт состояние заново, а не запомненное при сборке", async () => {
    const published: NotificationEvent[] = [];
    const state = createStateSource(board(12));
    const stateSync = new StateSync(state, {
        notify: async (event): Promise<void> => {
            published.push(event);
        },
    });

    await stateSync.publishCurrentState();
    state.servers = board(40);
    await stateSync.publishCurrentState();

    assert.deepEqual(
        published
            .filter(event => event.type === "serverStateRepublished")
            .map(event => event.snapshots[0]?.currentInfo?.players),
        [12, 40],
    );
});

test("публикует статус каждого сервера обычными событиями serverOnline/serverOffline", async () => {
    const published: NotificationEvent[] = [];
    const stateSync = new StateSync(
        createStateSource([snapshot(1, "online"), snapshot(2, "offline")]),
        {
            notify: async (event): Promise<void> => {
                published.push(event);
            },
        },
    );

    await stateSync.publishCurrentState();

    assert.deepEqual(
        published.map(event => event.type),
        ["serverStateRepublished", "serverOnline", "serverOffline"],
    );
});

test("сервер в статусе unknown пропускается: публиковать про него нечего", async () => {
    const published: NotificationEvent[] = [];
    const stateSync = new StateSync(
        createStateSource([snapshot(1, "unknown"), snapshot(2, "online")]),
        {
            notify: async (event): Promise<void> => {
                published.push(event);
            },
        },
    );

    await stateSync.publishCurrentState();

    assert.deepEqual(
        published.map(event => event.type),
        ["serverStateRepublished", "serverOnline"],
        "у unknown-сервера события нет, остальные не задеты",
    );
});

test("состояние, потерянное упавшей доставкой, доезжает следующим тиком", async () => {
    //Это ровно сценарий из итерации 5b, который тогда заканчивался «доставлено: []»:
    //TeamSpeak недоступен, доставка падает, накопленное состояние выбрасывать некому.
    const inner = createControllable();
    const teamSpeak = new LatestOnlyNotifier(inner, createLogger());
    const dispatcher = new NotificationDispatcher(
        [
            subscribe("serverStateUpdated", "teamspeak", teamSpeak),
            subscribe("serverStateRepublished", "teamspeak", teamSpeak),
        ],
        createLogger(),
    );
    const state = createStateSource(board(12));
    const stateSync = new StateSync(state, dispatcher);

    //Изменение состояния: 12 игроков. Доставка занята и упадёт.
    inner.failNext(new Error("TeamSpeak недоступен"));
    const failing = dispatcher.notify({type: "serverStateUpdated", snapshots: board(12)});
    await flush();

    //Пока падающая доставка висит, серверы опустели — приходит новое состояние.
    state.servers = board(0);
    void dispatcher.notify({type: "serverStateUpdated", snapshots: board(0)});
    await flush();

    inner.release();
    await failing;
    await flush();

    assert.deepEqual(inner.delivered, [], "состояние 0 потеряно: доставка упала, цикла больше нет");

    //Тик периодической синхронизации — единственное, что теперь может исправить описание канала.
    const tick = stateSync.publishCurrentState();
    await flush();
    inner.release();
    await tick;

    assert.deepEqual(
        inner.delivered,
        [{type: "serverStateRepublished", players: 0}],
        "тик доставил актуальное состояние, описание канала больше не врёт",
    );
});

test("тик перезаписывает описание, даже когда состояние не менялось", async () => {
    //Так откатывается правка описания канала, сделанная в TeamSpeak руками: запись безусловная.
    const inner = createControllable();
    const teamSpeak = new LatestOnlyNotifier(inner, createLogger());
    const dispatcher = new NotificationDispatcher(
        [subscribe("serverStateRepublished", "teamspeak", teamSpeak)],
        createLogger(),
    );
    const stateSync = new StateSync(createStateSource(board(12)), dispatcher);

    for (let tickNumber = 0; tickNumber < 3; tickNumber++) {
        const tick = stateSync.publishCurrentState();
        await flush();
        inner.release();
        await tick;
    }

    assert.equal(inner.delivered.length, 3, "три тика — три записи, несмотря на неизменное состояние");
});

test("принудительная публикация идёт МИМО дедупликации потребителя", async () => {
    //Главное свойство разделения serverStateUpdated / serverStateRepublished. Первое проходит
    //через обёртку и молчит на неизменном состоянии; второе пишет всегда — иначе описание,
    //поправленное в TeamSpeak руками, мы бы не вернули никогда: у себя-то мы ничего не меняли.
    const written: string[] = [];
    const channel: Notifier<ViewEvent> = {
        notify: async (event): Promise<void> => {
            written.push(event.type);
        },
    };
    const dispatcher = new NotificationDispatcher(
        [
            subscribe("serverStateUpdated", "teamspeak", new ChangesOnlyNotifier(
                channel,
                () => "channelDescription",
                event => JSON.stringify(event.snapshots.map(server => server.currentInfo?.players)),
            )),
            subscribe("serverStateRepublished", "teamspeak", channel),
        ],
        createLogger(),
    );
    const stateSync = new StateSync(createStateSource(board(12)), dispatcher);

    await dispatcher.notify({type: "serverStateUpdated", snapshots: board(12)});
    await dispatcher.notify({type: "serverStateUpdated", snapshots: board(12)});

    assert.deepEqual(written, ["serverStateUpdated"], "неизменное состояние второй записи не вызвало");

    await stateSync.publishCurrentState();

    assert.deepEqual(
        written,
        ["serverStateUpdated", "serverStateRepublished"],
        "тик записал вопреки тому, что состояние то же самое",
    );
});

test("лог не получает переопубликованное состояние: у него подписка только на изменения", async () => {
    //Разделение serverStateUpdated / serverStateRepublished существует ровно для этого: журнал
    //изменений не должен писать состояние целиком каждую минуту.
    const changesOnly: NotificationEvent[] = [];
    const logNotifier: Notifier<"serverStateUpdated"> = {
        notify: async (event): Promise<void> => {
            changesOnly.push(event);
        },
    };
    const dispatcher = new NotificationDispatcher(
        [subscribe("serverStateUpdated", "log", logNotifier)],
        createLogger(),
    );
    const stateSync = new StateSync(createStateSource(board(12)), dispatcher);

    await stateSync.publishCurrentState();
    await stateSync.publishCurrentState();

    assert.deepEqual(changesOnly, [], "тики синхронизации в журнал не попали");

    await dispatcher.notify({type: "serverStateUpdated", snapshots: board(40)});

    assert.equal(changesOnly.length, 1, "реальное изменение по-прежнему логируется");
});
