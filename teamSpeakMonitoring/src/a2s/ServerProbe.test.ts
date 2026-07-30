import test from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import type {ServerInfo} from "@callowayisweird/source-query";
import {ServerProbe, type ServerSnapshot} from "./ServerProbe.js";
import type {ServerMonitorConfig} from "./config.js";

//Характеризационные тесты: фиксируют поведение как есть, до рефакторинга.
//Порог намеренно меньше боевого (5), чтобы тесты читались.
const MAX_FAILED_CHECKS = 3;

const serverConfig: ServerMonitorConfig = {
    id: 1,
    name: "Test server",
    gameAddress: "127.0.0.1:2001",
    query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000},
};

//ServerInfo из библиотеки A2S требует 15 полей, а домену нужны два: players и maxPlayers.
//Ровно эта протечка убирается в итерации 3.
function serverInfo(players: number, maxPlayers: number = 64): ServerInfo {
    return {
        protocol: 17,
        name: "Test server",
        map: "Everon",
        folder: "reforger",
        game: "Arma Reforger",
        appId: 1874880,
        players,
        maxPlayers,
        bots: 0,
        serverType: "d",
        os: "l",
        visibility: false,
        vac: false,
        version: "1.0.0",
    };
}

const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
} as unknown as Logger;

function createProbe(): ServerProbe {
    return new ServerProbe(serverConfig, MAX_FAILED_CHECKS, silentLogger);
}

//Собирает события probe в порядке возникновения: порядок — часть наблюдаемого поведения.
function recordEvents(probe: ServerProbe): string[] {
    const events: string[] = [];

    for (const name of ["playersChanged", "serverStatusChanged", "online", "offline"]) {
        probe.on(name, () => events.push(name));
    }

    return events;
}

function failTimes(probe: ServerProbe, times: number): void {
    for (let attempt = 0; attempt < times; attempt += 1) {
        probe.handleResult(undefined);
    }
}

test("новый probe находится в статусе unknown без накопленных неудач", () => {
    const snapshot: ServerSnapshot = createProbe().getSnapshot();

    assert.equal(snapshot.status, "unknown");
    assert.equal(snapshot.failedChecks, 0);
    assert.equal(snapshot.info, undefined);
    assert.equal(snapshot.lastInfo, undefined);
});

test("первый успешный ответ переводит probe в online", () => {
    const probe = createProbe();
    const events = recordEvents(probe);

    probe.handleResult(serverInfo(10));
    const snapshot = probe.getSnapshot();

    assert.equal(snapshot.status, "online");
    assert.equal(snapshot.failedChecks, 0);
    assert.equal(snapshot.info?.players, 10);
    assert.equal(snapshot.info?.maxPlayers, 64);
    //Число игроков изменилось с undefined на 10, поэтому playersChanged тоже эмитится.
    assert.deepEqual(events, ["playersChanged", "serverStatusChanged", "online"]);
});

test("неудачи ниже порога не меняют статус и не порождают событий", () => {
    const probe = createProbe();
    const events = recordEvents(probe);

    failTimes(probe, MAX_FAILED_CHECKS - 1);
    const snapshot = probe.getSnapshot();

    assert.equal(snapshot.status, "unknown");
    assert.equal(snapshot.failedChecks, MAX_FAILED_CHECKS - 1);
    assert.deepEqual(events, []);
});

test("неудача на пороге переводит probe в offline", () => {
    const probe = createProbe();
    const events = recordEvents(probe);

    failTimes(probe, MAX_FAILED_CHECKS);
    const snapshot = probe.getSnapshot();

    assert.equal(snapshot.status, "offline");
    assert.deepEqual(events, ["serverStatusChanged", "offline"]);
});

test("успех после offline немедленно возвращает online", () => {
    const probe = createProbe();
    probe.handleResult(serverInfo(10));
    failTimes(probe, MAX_FAILED_CHECKS);
    assert.equal(probe.getSnapshot().status, "offline");

    const events = recordEvents(probe);
    //Одного успешного ответа достаточно: гистерезис асимметричный.
    probe.handleResult(serverInfo(10));

    assert.equal(probe.getSnapshot().status, "online");
    //Число игроков то же, что до падения, поэтому playersChanged не эмитится.
    assert.deepEqual(events, ["serverStatusChanged", "online"]);
});

test("успех сбрасывает счётчик неудач", () => {
    const probe = createProbe();

    failTimes(probe, MAX_FAILED_CHECKS - 1);
    assert.equal(probe.getSnapshot().failedChecks, MAX_FAILED_CHECKS - 1);

    probe.handleResult(serverInfo(10));

    assert.equal(probe.getSnapshot().failedChecks, 0);
});

test("счётчик неудач не растёт выше порога", () => {
    const probe = createProbe();
    const events = recordEvents(probe);

    failTimes(probe, MAX_FAILED_CHECKS + 20);

    assert.equal(probe.getSnapshot().failedChecks, MAX_FAILED_CHECKS);
    //Переход в offline произошёл один раз, дальнейшие неудачи событий не порождают.
    assert.deepEqual(events, ["serverStatusChanged", "offline"]);
});

test("playersChanged эмитится только при изменении числа игроков", () => {
    const probe = createProbe();
    probe.handleResult(serverInfo(10));

    const events = recordEvents(probe);

    probe.handleResult(serverInfo(10));
    assert.deepEqual(events, [], "то же число игроков события не даёт");

    probe.handleResult(serverInfo(11));
    assert.deepEqual(events, ["playersChanged"]);
});

test("statusSince обновляется только при смене статуса", () => {
    const probe = createProbe();
    probe.handleResult(serverInfo(10));
    const afterOnline = probe.getSnapshot().statusSince;

    probe.handleResult(serverInfo(11));
    assert.equal(
        probe.getSnapshot().statusSince,
        afterOnline,
        "статус не менялся — тот же объект Date",
    );

    failTimes(probe, MAX_FAILED_CHECKS);
    assert.notEqual(
        probe.getSnapshot().statusSince,
        afterOnline,
        "переход в offline создаёт новый Date",
    );
});

test("offline скрывает info, но сохраняет lastInfo", () => {
    const probe = createProbe();
    probe.handleResult(serverInfo(10));
    failTimes(probe, MAX_FAILED_CHECKS);

    const snapshot = probe.getSnapshot();

    assert.equal(snapshot.info, undefined, "info отдаётся только для online");
    assert.equal(snapshot.lastInfo?.players, 10, "последние известные данные сохраняются");
});

test("getServerName отдаёт имя из конфигурации", () => {
    assert.equal(createProbe().getServerName(), "Test server");
});
