import test from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {ServerMonitor, type ServerDescriptionView} from "./ServerMonitor.js";
import type {ServerMonitorConfig} from "./MonitoredServer.js";
import type {Querier, QuerierRegistry, ServerQueryConfig, ServerQueryResult} from "./ServerQuery.js";
import type {MonitorProperties} from "../properties.js";

//Эти тесты стали возможны только после инъекции queriers: до неё ServerMonitor сам создавал
//A2sQuerier и RestQuerier, и любой тест полез бы в реальный UDP и HTTP.

const monitorProperties: MonitorProperties = {
    pollIntervalMs: 10_000,   //заведомо больше окна теста: опрос происходит один раз, на start()
    suspiciousPollIntervalMs: 10_000,
    maxFailedChecks: 3,
};

function a2sServer(id: number, name: string): ServerMonitorConfig {
    return {
        id,
        name,
        gameAddress: `127.0.0.1:200${id}`,
        query: {type: "a2s", host: "127.0.0.1", port: 17770 + id, timeout: 1000},
    };
}

function restServer(id: number, name: string): ServerMonitorConfig {
    return {
        id,
        name,
        gameAddress: "https://example.com",
        query: {type: "rest", url: "https://example.com/status", timeout: 1000},
    };
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
    const monitor = createMonitor({a2s, rest});

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
    const monitor = createMonitor({a2s, rest: createQuerier(undefined)});

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

test("результат опроса попадает в вид", async () => {
    const views: ServerDescriptionView[][] = [];
    const monitor = createMonitor({
        a2s: createQuerier({players: 17, maxPlayers: 64}),
        rest: createQuerier(undefined),
    });
    monitor.on("viewChanged", view => views.push(view));

    monitor.syncServers([a2sServer(1, "A2S server")]);
    monitor.start();
    await wait(40);
    monitor.stop();

    const last = views.at(-1);
    assert.deepEqual(last, [
        {id: 1, name: "A2S server", status: "online", players: 17, maxPlayers: 64},
    ]);
});

test("вид не эмитится повторно, если ничего не изменилось", async () => {
    let viewChangedCount = 0;
    const monitor = new ServerMonitor(
        //Тут опрос частый: нужно несколько тактов с одинаковым результатом.
        {pollIntervalMs: 10, suspiciousPollIntervalMs: 10, maxFailedChecks: 3},
        silentLogger,
        {a2s: createQuerier({players: 5, maxPlayers: 64}), rest: createQuerier(undefined)},
    );
    monitor.on("viewChanged", () => {
        viewChangedCount += 1;
    });

    monitor.syncServers([a2sServer(1, "A2S server")]);
    monitor.start();
    await wait(120);
    monitor.stop();

    //Такты прошли многократно, но вид менялся ровно один раз: unknown → online 5/64.
    assert.equal(viewChangedCount, 1);
});

test("неизвестный тип запроса не мешает опросу остальных серверов", async () => {
    //В БД query_type — обычная строка, поэтому туда может попасть что угодно.
    const brokenServer = {
        ...a2sServer(2, "Broken server"),
        query: {type: "carrier-pigeon", host: "127.0.0.1", port: 1, timeout: 1} as unknown as ServerQueryConfig,
    };
    const a2s = createQuerier({players: 1, maxPlayers: 2});
    const monitor = new ServerMonitor(
        {pollIntervalMs: 15, suspiciousPollIntervalMs: 15, maxFailedChecks: 3},
        silentLogger,
        {a2s, rest: createQuerier(undefined)},
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
    const monitor = createMonitor({a2s, rest: createQuerier(undefined)});

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
