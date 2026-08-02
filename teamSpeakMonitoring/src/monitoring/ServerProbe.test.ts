import test from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {ServerProbe, type ServerProbeSnapshot} from "./ServerProbe.js";
import type {ServerMonitorConfig} from "./MonitoredServer.js";
import type {ServerPollResult} from "./ServerQuery.js";
import {serverConfigFixture} from "../test/serverFixtures.js";

//Характеризационные тесты: фиксируют поведение как есть, до рефакторинга.
//Порог намеренно меньше боевого (5), чтобы тесты читались.
const MAX_FAILED_CHECKS = 3;

//probe конфиг только хранит и отдаёт в снапшоте: опрашивает источники монитор,
//поэтому их состав здесь не важен.
const serverConfig: ServerMonitorConfig = serverConfigFixture({name: "Test server"});

//До итерации 3 здесь собирался ServerInfo из библиотеки A2S: 15 обязательных полей, из которых
//домен читал два. Теперь это доменный тип, и фикстура равна тому, что домен действительно знает.
//alive — ответ главного источника; для probe это единственный источник статуса.
function pollSuccess(players: number, maxPlayers: number = 64): ServerPollResult {
    return {alive: true, info: {players, maxPlayers}};
}

//Главный источник промолчал. info пустой, а не отсутствующий: слиться было нечему.
function pollFailure(): ServerPollResult {
    return {alive: false, info: {}};
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

    probe.on("online", () => events.push("online"));
    probe.on("offline", () => events.push("offline"));

    return events;
}

function failTimes(probe: ServerProbe, times: number): void {
    for (let attempt = 0; attempt < times; attempt += 1) {
        probe.handleResult(pollFailure());
    }
}

test("новый probe находится в статусе unknown без накопленных неудач", () => {
    const snapshot: ServerProbeSnapshot = createProbe().getSnapshot();

    assert.equal(snapshot.status, "unknown");
    assert.equal(snapshot.failedChecks, 0);
    assert.equal(snapshot.currentInfo, undefined);
});

test("первый успешный ответ переводит probe в online", () => {
    const probe = createProbe();
    const events = recordEvents(probe);

    probe.handleResult(pollSuccess(10));
    const snapshot = probe.getSnapshot();

    assert.equal(snapshot.status, "online");
    assert.equal(snapshot.failedChecks, 0);
    assert.equal(snapshot.currentInfo?.players, 10);
    assert.equal(snapshot.currentInfo?.maxPlayers, 64);
    assert.deepEqual(events, ["online"]);
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
    assert.deepEqual(events, ["offline"]);
});

test("успех после offline немедленно возвращает online", () => {
    const probe = createProbe();
    probe.handleResult(pollSuccess(10));
    failTimes(probe, MAX_FAILED_CHECKS);
    assert.equal(probe.getSnapshot().status, "offline");

    const events = recordEvents(probe);
    //Одного успешного ответа достаточно: гистерезис асимметричный.
    probe.handleResult(pollSuccess(10));

    assert.equal(probe.getSnapshot().status, "online");
    assert.deepEqual(events, ["online"]);
});

test("успех сбрасывает счётчик неудач", () => {
    const probe = createProbe();

    failTimes(probe, MAX_FAILED_CHECKS - 1);
    assert.equal(probe.getSnapshot().failedChecks, MAX_FAILED_CHECKS - 1);

    probe.handleResult(pollSuccess(10));

    assert.equal(probe.getSnapshot().failedChecks, 0);
});

test("счётчик неудач не растёт выше порога", () => {
    const probe = createProbe();
    const events = recordEvents(probe);

    failTimes(probe, MAX_FAILED_CHECKS + 20);

    assert.equal(probe.getSnapshot().failedChecks, MAX_FAILED_CHECKS);
    //Переход в offline произошёл один раз, дальнейшие неудачи событий не порождают.
    assert.deepEqual(events, ["offline"]);
});

test("повторный успех с другим числом игроков не порождает событий", () => {
    //Событий у probe теперь ровно два — только переходы статуса. Изменение числа игроков
    //наружу отдаёт ServerMonitor через stateUpdated, у probe для этого события нет.
    const probe = createProbe();
    probe.handleResult(pollSuccess(10));

    const events = recordEvents(probe);

    probe.handleResult(pollSuccess(11));

    assert.deepEqual(events, []);
    assert.equal(probe.getSnapshot().currentInfo?.players, 11, "но данные обновились");
});

test("statusSince обновляется только при смене статуса", () => {
    const probe = createProbe();
    probe.handleResult(pollSuccess(10));
    const afterOnline = probe.getSnapshot().statusSince;

    probe.handleResult(pollSuccess(11));
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

test("offline гасит данные: наружу протухшее значение не выходит", () => {
    const probe = createProbe();
    probe.handleResult(pollSuccess(10));
    failTimes(probe, MAX_FAILED_CHECKS);

    const snapshot = probe.getSnapshot();

    assert.equal(snapshot.status, "offline");
    assert.equal(snapshot.currentInfo, undefined, "данные отдаются только для online");
});

test("в дребезге данные сохраняются: статус ещё online, значит они актуальны", () => {
    //Ровно та причина, по которой последние данные переживают неудачный опрос. Порог не достигнут,
    //сервер считается живым — показывать в этот момент "неизвестно" было бы враньём.
    const probe = createProbe();
    probe.handleResult(pollSuccess(10));
    failTimes(probe, MAX_FAILED_CHECKS - 1);

    const snapshot = probe.getSnapshot();

    assert.equal(snapshot.status, "online");
    assert.equal(snapshot.currentInfo?.players, 10);
});

test("getServerName отдаёт имя из конфигурации", () => {
    assert.equal(createProbe().getServerName(), "Test server");
});
