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
        {pollIntervalMs: 10, suspiciousPollIntervalMs: 10, maxFailedChecks: 3, secondaryGraceMs: 50, secondaryPollIntervalMs: 0},
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
        {pollIntervalMs: 15, suspiciousPollIntervalMs: 15, maxFailedChecks: 3, secondaryGraceMs: 50, secondaryPollIntervalMs: 0},
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
