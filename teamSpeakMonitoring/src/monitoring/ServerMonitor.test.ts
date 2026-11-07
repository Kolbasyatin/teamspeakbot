import test from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {ServerMonitor} from "./ServerMonitor.js";
import type {ServerMonitorConfig, ServerQuerySource} from "./MonitoredServer.js";
import type {Querier, QuerierRegistry, ServerQueryConfig, ServerQueryResult} from "./ServerQuery.js";
import type {MonitorProperties} from "../properties.js";
import type {ServerProbeSnapshot} from "./ServerProbe.js";

//Эти тесты стали возможны только после инъекции queriers: до неё ServerMonitor сам создавал
//A2sQuerier и RestQuerier, и любой тест полез бы в реальный UDP и HTTP.

const monitorProperties: MonitorProperties = {
    pollIntervalMs: 10_000,   //заведомо больше окна теста: опрос происходит один раз, на start()
    suspiciousPollIntervalMs: 10_000,
    maxFailedChecks: 3,
    //Второстепенных источников в этих тестах нет, поэтому окно ожидания никого не задерживает.
    secondaryGraceMs: 50,
    //Троттлинг второстепенных здесь не проверяется — у него свои тесты.
    secondaryPollIntervalMs: 0,
    //Режим «ожидается простой» — заметно отличными числами, чтобы в тестах было видно, чей план.
    watchPollIntervalMs: 20,
    watchTimeoutMs: 300,
    watchMaxFailedChecks: 2,
    watchDurationMs: 10_000,
};

//Сервер с единственным источником: пока опрашивается только главный, остальным тестам монитора
//знать про несколько источников нечего.
function singleSourceServer(
    id: number,
    name: string,
    gameAddress: string,
    query: ServerQueryConfig,
): ServerMonitorConfig {
    const primarySource: ServerQuerySource = {id, role: "primary", priority: 0, query};

    //primarySource — тот же объект, что в sources, как его собирает репозиторий.
    return {id, name, gameAddress, sources: [primarySource], primarySource};
}

function a2sServer(id: number, name: string): ServerMonitorConfig {
    return singleSourceServer(id, name, `127.0.0.1:200${id}`, {
        type: "a2s",
        host: "127.0.0.1",
        port: 17770 + id,
        timeout: 1000,
    });
}

function restServer(id: number, name: string): ServerMonitorConfig {
    return singleSourceServer(id, name, "https://example.com", {
        type: "rest",
        url: "https://example.com/status",
        timeout: 1000,
        fields: {players: "players", maxPlayers: "maxPlayers"},
    });
}

interface RecordingQuerier extends Querier {
    calls: ServerQueryConfig[];
}

function createQuerier(result: ServerQueryResult | undefined): RecordingQuerier {
    return {
        calls: [],
        async query(config: ServerQueryConfig): Promise<ServerQueryResult | undefined> {
            this.calls.push(config);
            return result;
        },
    } as RecordingQuerier;
}

const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
} as unknown as Logger;

function createMonitor(queriers: QuerierRegistry): ServerMonitor {
    return new ServerMonitor(monitorProperties, silentLogger, queriers);
}

function wait(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

test("монитор выбирает querier по типу запроса", async () => {
    const a2s = createQuerier({players: 10, maxPlayers: 64});
    const rest = createQuerier({players: 3, maxPlayers: 32});
    const monitor = createMonitor({a2s, rest, bohemia: createQuerier(undefined)});

    monitor.syncServers([a2sServer(1, "A2S server"), restServer(2, "REST server")]);
    monitor.start();
    await wait(40);
    monitor.stop();

    assert.equal(a2s.calls.length, 1, "a2s-сервер опрошен через a2s-querier");
    assert.equal(rest.calls.length, 1, "rest-сервер опрошен через rest-querier");
    assert.equal(a2s.calls[0]?.type, "a2s");
    assert.equal(rest.calls[0]?.type, "rest");
});

test("querier получает конфиг именно своего сервера", async () => {
    const a2s = createQuerier({players: 1, maxPlayers: 2});
    const monitor = createMonitor({a2s, rest: createQuerier(undefined), bohemia: createQuerier(undefined)});

    monitor.syncServers([a2sServer(5, "Fifth")]);
    monitor.start();
    await wait(40);
    monitor.stop();

    assert.deepEqual(a2s.calls[0], {
        type: "a2s",
        host: "127.0.0.1",
        port: 17775,
        timeout: 1000,
    });
});

test("результат опроса попадает в состояние", async () => {
    const updates: ServerProbeSnapshot[][] = [];
    const monitor = createMonitor({
        a2s: createQuerier({players: 17, maxPlayers: 64}),
        rest: createQuerier(undefined),
        bohemia: createQuerier(undefined),
    });
    monitor.on("stateUpdated", snapshots => updates.push(snapshots));

    monitor.syncServers([a2sServer(1, "A2S server")]);
    monitor.start();
    await wait(40);
    monitor.stop();

    const last = updates.at(-1)?.at(0);
    assert.equal(last?.config.name, "A2S server");
    assert.equal(last?.status, "online");
    assert.deepEqual(last?.currentInfo, {players: 17, maxPlayers: 64});
});

test("состояние эмитится после каждого опроса, даже когда ничего не изменилось", async () => {
    //Раньше монитор сравнивал вид с прошлым и молчал на совпадении. Сравнение переехало
    //к потребителям: у описания канала и у журнала разные представления о том, что считать
    //изменением, и решать за них здесь нечем. Монитор сообщает факт «опрос прошёл».
    let updates = 0;
    const monitor = new ServerMonitor(
        //Тут опрос частый: нужно несколько тактов с одинаковым результатом.
        {...monitorProperties, pollIntervalMs: 10, suspiciousPollIntervalMs: 10},
        silentLogger,
        {a2s: createQuerier({players: 5, maxPlayers: 64}), rest: createQuerier(undefined), bohemia: createQuerier(undefined)},
    );
    monitor.on("stateUpdated", () => {
        updates += 1;
    });

    monitor.syncServers([a2sServer(1, "A2S server")]);
    monitor.start();
    await wait(120);
    monitor.stop();

    assert.ok(updates > 1, `тактов прошло несколько, событий должно быть столько же, а не одно: ${updates}`);
});

test("неизвестный тип запроса не мешает опросу остальных серверов", async () => {
    //В БД query_type — обычная строка, поэтому туда может попасть что угодно.
    const brokenServer = singleSourceServer(
        2,
        "Broken server",
        "127.0.0.1:2002",
        {type: "carrier-pigeon", host: "127.0.0.1", port: 1, timeout: 1} as unknown as ServerQueryConfig,
    );
    const a2s = createQuerier({players: 1, maxPlayers: 2});
    const monitor = new ServerMonitor(
        {...monitorProperties, pollIntervalMs: 15, suspiciousPollIntervalMs: 15},
        silentLogger,
        {a2s, rest: createQuerier(undefined), bohemia: createQuerier(undefined)},
    );

    monitor.syncServers([a2sServer(1, "Healthy server"), brokenServer]);
    monitor.start();
    await wait(120);
    monitor.stop();

    //Исключение из-за неизвестного типа перехватывается Scheduler'ом (итерация 0),
    //поэтому исправный сервер продолжает опрашиваться.
    assert.ok(a2s.calls.length >= 3, `исправный сервер опрошен ${a2s.calls.length} раз`);
});

test("syncServers добавляет и удаляет серверы из опроса", async () => {
    const a2s = createQuerier({players: 1, maxPlayers: 2});
    const monitor = createMonitor({a2s, rest: createQuerier(undefined), bohemia: createQuerier(undefined)});

    monitor.syncServers([a2sServer(1, "First")]);
    monitor.start();
    await wait(40);
    assert.equal(a2s.calls.length, 1);

    monitor.syncServers([a2sServer(1, "First"), a2sServer(2, "Second")]);
    await wait(40);
    assert.equal(a2s.calls.length, 2, "новый сервер опрошен сразу, старый не переопрошен");

    monitor.syncServers([a2sServer(1, "First")]);
    assert.equal(monitor.getSnapshot().length, 1, "удалённый сервер выпал из снапшота");
    monitor.stop();
});

test("syncServers пересоздаёт только сервер с изменённым конфигом", async () => {
    //Правка источника в админке должна дойти до опроса без forceSync, который сбросил бы
    //состояние всех серверов, а не одного. Пересозданный probe опрашивается на СЛЕДУЮЩЕМ тике:
    //планировщик берёт задачу по id в момент срабатывания, таймер сервера не сбрасывается.
    const a2s = createQuerier({players: 1, maxPlayers: 2});
    const monitor = new ServerMonitor(
        {...monitorProperties, pollIntervalMs: 30},
        silentLogger,
        {a2s, rest: createQuerier(undefined), bohemia: createQuerier(undefined)},
    );
    const snapshotOf = (id: number): ServerProbeSnapshot | undefined =>
        monitor.getSnapshot().find(snapshot => snapshot.config.id === id);

    try {
        monitor.syncServers([a2sServer(1, "First"), a2sServer(2, "Second")]);
        monitor.start();
        await wait(20);

        const unchangedSince = snapshotOf(1)?.statusSince;

        assert.equal(snapshotOf(1)?.status, "online");

        monitor.syncServers([a2sServer(1, "First"), singleSourceServer(2, "Second", "127.0.0.1:2002", {
            type: "a2s",
            host: "127.0.0.1",
            port: 19999,
            timeout: 1000,
        })]);

        assert.equal(snapshotOf(2)?.status, "unknown", "изменённый сервер начал с чистого состояния");
        assert.equal(snapshotOf(1)?.statusSince, unchangedSince, "неизменённый сохранил состояние");

        const callsBefore = a2s.calls.length;

        await wait(60);

        const portsAfter = a2s.calls.slice(callsBefore).map(call => call.type === "a2s" ? call.port : 0);

        assert.ok(portsAfter.includes(19999), "следующий опрос идёт по новому конфигу");
        assert.ok(!portsAfter.includes(17772), "по старому конфигу больше не опрашивается");
    } finally {
        monitor.stop();
    }
});

test("checkOnce опрашивает сервер без расписания, probe и событий", async () => {
    //Кнопка «проверить» в боте: сервер никому не подписан, probe у него нет, а ответ нужен
    //тому, кто нажал. Монитор при этом не должен ни запомнить сервер, ни разбудить нотифаеры.
    const a2s = createQuerier({players: 12, maxPlayers: 64});
    const monitor = createMonitor({a2s, rest: createQuerier(undefined), bohemia: createQuerier(undefined)});
    let updates = 0;
    monitor.on("stateUpdated", () => {
        updates += 1;
    });

    const result = await monitor.checkOnce(a2sServer(9, "Unsubscribed"));

    assert.deepEqual(result, {alive: true, info: {players: 12, maxPlayers: 64}});
    assert.equal(a2s.calls.length, 1);
    assert.deepEqual(a2s.calls[0], {type: "a2s", host: "127.0.0.1", port: 17779, timeout: 1000}, "опрошен именно переданный сервер");
    assert.deepEqual(monitor.getSnapshot(), [], "probe не появился");
    assert.equal(updates, 0, "событий не было");
});

test("checkOnce честно отдаёт молчание главного источника", async () => {
    const monitor = createMonitor({
        a2s: createQuerier(undefined),
        rest: createQuerier(undefined),
        bohemia: createQuerier(undefined),
    });

    assert.deepEqual(await monitor.checkOnce(a2sServer(1, "Silent")), {alive: false, info: {}});
});

//Режим «ожидается простой» (PollPolicy, telegram.md §11). В monitorProperties обычный опрос —
//раз в 10 секунд, то есть за окно теста один раз, на старте; всё, что сверх, — заслуга режима.

//Querier, отвечающий по сценарию: i-й вызов — i-й ответ, после конца сценария — последний.
function scriptedQuerier(script: readonly (ServerQueryResult | undefined)[]): RecordingQuerier {
    return {
        calls: [],
        async query(config: ServerQueryConfig): Promise<ServerQueryResult | undefined> {
            this.calls.push(config);
            return script[Math.min(this.calls.length, script.length) - 1];
        },
    } as RecordingQuerier;
}

const ANSWER: ServerQueryResult = {players: 120, maxPlayers: 128};

function watchMonitor(a2s: Querier, bohemia: Querier = createQuerier(undefined), now?: () => number): ServerMonitor {
    return new ServerMonitor(monitorProperties, silentLogger, {a2s, rest: createQuerier(undefined), bohemia}, now);
}

test("watchClosely учащает опрос и режет таймаут только главному источнику", async () => {
    const a2s = createQuerier(ANSWER);
    const bohemia = createQuerier({queueSize: 3});
    const monitor = watchMonitor(a2s, bohemia);
    const primary: ServerQuerySource = {id: 1, role: "primary", priority: 0, query: {
        type: "a2s", host: "127.0.0.1", port: 17771, timeout: 1000,
    }};
    const secondary: ServerQuerySource = {id: 2, role: "secondary", priority: 1, query: {
        type: "bohemia", hostAddress: "127.0.0.1:2001", timeout: 5000,
    }};

    try {
        monitor.syncServers([{id: 1, name: "#1", gameAddress: "127.0.0.1:2001", sources: [primary, secondary], primarySource: primary}]);
        monitor.start();
        await wait(30);
        assert.equal(a2s.calls.length, 1, "до сигнала — обычный опрос, один раз на старте");

        monitor.watchClosely(1);
        await wait(120);
    } finally {
        monitor.stop();
    }

    assert.ok(a2s.calls.length >= 4, `в режиме опрос частый: ${a2s.calls.length}`);
    assert.equal(a2s.calls[0]?.timeout, 1000, "до режима таймаут из конфига");
    assert.ok(a2s.calls.slice(1).every(call => call.timeout === 300), "в режиме — потолок из MONITOR_WATCH_TIMEOUT_MS");
    assert.ok(bohemia.calls.every(call => call.timeout === 5000), "второстепенному таймаут не режем: статус решает не он");
});

test("в режиме ожидания две неудачи подряд дают offline", async () => {
    const offline: ServerProbeSnapshot[] = [];
    const monitor = watchMonitor(scriptedQuerier([ANSWER, undefined]));
    monitor.on("serverOffline", snapshot => offline.push(snapshot));

    try {
        monitor.syncServers([a2sServer(1, "#1")]);
        monitor.start();
        await wait(30);

        monitor.watchClosely(1);
        await wait(80);
    } finally {
        monitor.stop();
    }

    assert.equal(offline.length, 1, "обычный порог — три неудачи по 10 секунд; в режиме хватило двух за десятки мс");
    assert.equal(offline[0]?.failedChecks, 2);
});

test("сервер вернулся после падения — режим выключается сам", async () => {
    const a2s = scriptedQuerier([ANSWER, undefined, undefined, ANSWER]);
    const monitor = watchMonitor(a2s);
    const events: string[] = [];
    monitor.on("serverOffline", () => events.push("offline"));
    monitor.on("serverOnline", () => events.push("online"));

    try {
        monitor.syncServers([a2sServer(1, "#1")]);
        monitor.start();
        await wait(30);

        monitor.watchClosely(1);
        await wait(150);

        const callsAfterComeback = a2s.calls.length;

        await wait(80);

        assert.deepEqual(events, ["online", "offline", "online"], "перезапуск пойман: упал и поднялся");
        assert.equal(a2s.calls.length, callsAfterComeback, "после подъёма — снова обычный опрос, раз в 10 секунд");
    } finally {
        monitor.stop();
    }
});

test("ожидаемого простоя не случилось — режим кончается по сроку", async () => {
    let clock = 0;
    const a2s = createQuerier(ANSWER);
    const monitor = watchMonitor(a2s, createQuerier(undefined), () => clock);

    try {
        monitor.syncServers([a2sServer(1, "#1")]);
        monitor.start();
        await wait(30);

        monitor.watchClosely(1);
        await wait(60);
        assert.ok(a2s.calls.length >= 3, "режим действует");

        clock = monitorProperties.watchDurationMs + 1;
        //Уже взведённый короткий таймер отработает, а план после него — обычный.
        await wait(40);

        const callsAfterExpiry = a2s.calls.length;

        await wait(80);

        assert.equal(a2s.calls.length, callsAfterExpiry);
        assert.equal(monitor.getSnapshot()[0]?.status, "online", "сервер всё это время отвечал");
    } finally {
        monitor.stop();
    }
});

test("watchClosely по серверу, которого нет в опросе, ничего не делает", () => {
    const monitor = watchMonitor(createQuerier(ANSWER));

    assert.doesNotThrow(() => monitor.watchClosely(42));
    assert.deepEqual(monitor.getSnapshot(), []);
});
