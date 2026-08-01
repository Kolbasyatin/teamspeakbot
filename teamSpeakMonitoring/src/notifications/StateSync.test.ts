import test from "node:test";
import assert from "node:assert/strict";
import {StateSync, type CurrentStateSource} from "./StateSync.js";
import {LatestOnlyNotifier} from "./LatestOnlyNotifier.js";
import {NotificationDispatcher} from "./NotificationDispatcher.js";
import {subscribe, type NotificationEvent, type NotificationEventOf, type Notifier} from "./events.js";
import type {ServerDescriptionView} from "../monitoring/ServerMonitor.js";
import type {ServerSnapshot, ServerStatus} from "../monitoring/ServerProbe.js";
import type {Logger} from "pino";
import {serverConfigFixture} from "../test/serverFixtures.js";

type ViewEvent = "statusViewChanged" | "statusViewRefreshed";

function view(players: number): ServerDescriptionView[] {
    return [{id: 1, name: "Test server", status: "online", players, maxPlayers: 64}];
}

function snapshot(id: number, status: ServerStatus): ServerSnapshot {
    return {
        config: serverConfigFixture({id}),
        status,
        failedChecks: 0,
        currentInfo: undefined,
        statusSince: new Date(0),
    };
}

//Источник состояния, который можно менять между тиками: тик обязан брать актуальное,
//а не то, что было на момент сборки.
function createStateSource(
    initial: number,
    servers: ServerSnapshot[] = [],
): CurrentStateSource & {players: number; servers: ServerSnapshot[]} {
    return {
        players: initial,
        servers,
        getView(): ServerDescriptionView[] {
            return view(this.players);
        },
        getSnapshot(): ServerSnapshot[] {
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

            this.delivered.push({type: event.type, players: event.view[0]?.players ?? -1});
        },
    } as ControllableNotifier;
}

function flush(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

test("публикует текущее состояние событием statusViewRefreshed", async () => {
    const published: NotificationEvent[] = [];
    const stateSync = new StateSync(createStateSource(12), {
        notify: async (event): Promise<void> => {
            published.push(event);
        },
    });

    await stateSync.publishCurrentState();

    assert.deepEqual(published, [{type: "statusViewRefreshed", view: view(12)}]);
});

test("каждый тик берёт состояние заново, а не запомненное при сборке", async () => {
    const published: NotificationEvent[] = [];
    const state = createStateSource(12);
    const stateSync = new StateSync(state, {
        notify: async (event): Promise<void> => {
            published.push(event);
        },
    });

    await stateSync.publishCurrentState();
    state.players = 40;
    await stateSync.publishCurrentState();

    assert.deepEqual(
        published.map(event => (event.type === "statusViewRefreshed" ? event.view[0]?.players : undefined)),
        [12, 40],
    );
});

test("публикует статус каждого сервера обычными событиями serverOnline/serverOffline", async () => {
    const published: NotificationEvent[] = [];
    const stateSync = new StateSync(
        createStateSource(12, [snapshot(1, "online"), snapshot(2, "offline")]),
        {
            notify: async (event): Promise<void> => {
                published.push(event);
            },
        },
    );

    await stateSync.publishCurrentState();

    assert.deepEqual(
        published.map(event => event.type),
        ["statusViewRefreshed", "serverOnline", "serverOffline"],
    );
});

test("сервер в статусе unknown пропускается: публиковать про него нечего", async () => {
    const published: NotificationEvent[] = [];
    const stateSync = new StateSync(
        createStateSource(12, [snapshot(1, "unknown"), snapshot(2, "online")]),
        {
            notify: async (event): Promise<void> => {
                published.push(event);
            },
        },
    );

    await stateSync.publishCurrentState();

    assert.deepEqual(
        published.map(event => event.type),
        ["statusViewRefreshed", "serverOnline"],
        "у unknown-сервера события нет, остальные не задеты",
    );
});

test("состояние, потерянное упавшей доставкой, доезжает следующим тиком", async () => {
    //Это ровно сценарий из итерации 5b, который тогда заканчивался «доставлено: []»:
    //TeamSpeak недоступен, доставка падает, накопленное состояние выбрасывать некому,
    //а ServerMonitor следующего viewChanged не пришлёт — состояние больше не меняется.
    const inner = createControllable();
    const teamSpeak = new LatestOnlyNotifier(inner, createLogger());
    const dispatcher = new NotificationDispatcher(
        [
            subscribe("statusViewChanged", "teamspeak", teamSpeak),
            subscribe("statusViewRefreshed", "teamspeak", teamSpeak),
        ],
        createLogger(),
    );
    const state = createStateSource(12);
    const stateSync = new StateSync(state, dispatcher);

    //Изменение состояния: 12 игроков. Доставка занята и упадёт.
    inner.failNext(new Error("TeamSpeak недоступен"));
    const failing = dispatcher.notify({type: "statusViewChanged", view: view(12)});
    await flush();

    //Пока падающая доставка висит, серверы легли — приходит новое состояние.
    state.players = 0;
    void dispatcher.notify({type: "statusViewChanged", view: view(0)});
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
        [{type: "statusViewRefreshed", players: 0}],
        "тик доставил актуальное состояние, описание канала больше не врёт",
    );
});

test("тик перезаписывает описание, даже когда состояние не менялось", async () => {
    //Так откатывается правка описания канала, сделанная в TeamSpeak руками: запись безусловная.
    const inner = createControllable();
    const teamSpeak = new LatestOnlyNotifier(inner, createLogger());
    const dispatcher = new NotificationDispatcher(
        [subscribe("statusViewRefreshed", "teamspeak", teamSpeak)],
        createLogger(),
    );
    const stateSync = new StateSync(createStateSource(12), dispatcher);

    for (let tickNumber = 0; tickNumber < 3; tickNumber++) {
        const tick = stateSync.publishCurrentState();
        await flush();
        inner.release();
        await tick;
    }

    assert.equal(inner.delivered.length, 3, "три тика — три записи, несмотря на неизменное состояние");
});

test("лог не получает переопубликованное состояние: у него подписка только на изменения", async () => {
    //Разделение statusViewChanged / statusViewRefreshed существует ровно для этого: журнал изменений
    //не должен писать вид целиком каждую минуту.
    const changesOnly: NotificationEvent[] = [];
    const logNotifier: Notifier<"statusViewChanged"> = {
        notify: async (event): Promise<void> => {
            changesOnly.push(event);
        },
    };
    const dispatcher = new NotificationDispatcher(
        [subscribe("statusViewChanged", "log", logNotifier)],
        createLogger(),
    );
    const stateSync = new StateSync(createStateSource(12), dispatcher);

    await stateSync.publishCurrentState();
    await stateSync.publishCurrentState();

    assert.deepEqual(changesOnly, [], "тики синхронизации в журнал не попали");

    await dispatcher.notify({type: "statusViewChanged", view: view(40)});

    assert.equal(changesOnly.length, 1, "реальное изменение по-прежнему логируется");
});
