import test from "node:test";
import assert from "node:assert/strict";
import {SecondarySourceThrottle} from "./SecondarySourceThrottle.js";
import type {ServerMonitorConfig, ServerQuerySource} from "./MonitoredServer.js";
import type {SourceQueryRunner} from "./pollServerSources.js";
import type {ServerQueryResult} from "./ServerQuery.js";

//Время подменяется счётчиком: проверяются решения «спросить или отдать прошлое», а не таймеры.

function source(id: number, role: "primary" | "secondary"): ServerQuerySource {
    return {id, role, priority: id, query: {type: "a2s", host: "127.0.0.1", port: 17770 + id, timeout: 1000}};
}

const PRIMARY = source(1, "primary");
const SECONDARY = source(2, "secondary");

function config(...sources: ServerQuerySource[]): ServerMonitorConfig {
    return {id: 100, name: "Test", gameAddress: "127.0.0.1:2001", sources, primarySource: PRIMARY};
}

//Считает вызовы по источникам и отдаёт заданный результат.
function runner(
    results: Record<number, () => Promise<ServerQueryResult | undefined>>,
): SourceQueryRunner & {calls: number[]} {
    const calls: number[] = [];
    const run = ((src: ServerQuerySource) => {
        calls.push(src.id);

        return results[src.id]!();
    }) as SourceQueryRunner & {calls: number[]};

    run.calls = calls;

    return run;
}

test("главный опрашивается на каждом тике, второстепенный — не чаще интервала", async () => {
    const now = {value: 0};
    const throttle = new SecondarySourceThrottle(30_000, () => now.value);
    const run = runner({1: async () => ({players: 1}), 2: async () => ({queueSize: 7})});
    const wrapped = throttle.wrap(run, config(PRIMARY, SECONDARY));

    await wrapped(PRIMARY);
    await wrapped(SECONDARY);
    now.value = 5_000;
    await wrapped(PRIMARY);
    await wrapped(SECONDARY);
    now.value = 30_000;
    await wrapped(PRIMARY);
    await wrapped(SECONDARY);

    assert.deepEqual(run.calls, [1, 2, 1, 1, 2]);
});

test("между опросами второстепенный отдаёт прошлый ответ, а не пустоту", async () => {
    //Иначе очередь мигала бы в табло на каждом тике без опроса.
    const now = {value: 0};
    const throttle = new SecondarySourceThrottle(30_000, () => now.value);
    let answer: ServerQueryResult = {queueSize: 7};
    const wrapped = throttle.wrap(runner({2: async () => answer}), config(PRIMARY, SECONDARY));

    assert.deepEqual(await wrapped(SECONDARY), {queueSize: 7});
    answer = {queueSize: 9};
    now.value = 10_000;
    assert.deepEqual(await wrapped(SECONDARY), {queueSize: 7}, "интервал не истёк — прошлый ответ");
    now.value = 30_000;
    assert.deepEqual(await wrapped(SECONDARY), {queueSize: 9}, "интервал истёк — свежий");
});

test("нулевой интервал — второстепенные опрашиваются каждый тик", async () => {
    const throttle = new SecondarySourceThrottle(0, () => 0);
    const run = runner({2: async () => ({queueSize: 1})});
    const wrapped = throttle.wrap(run, config(PRIMARY, SECONDARY));

    await wrapped(SECONDARY);
    await wrapped(SECONDARY);

    assert.deepEqual(run.calls, [2, 2]);
});

test("ошибка второстепенного не запоминается — следующий тик повторит запрос", async () => {
    const now = {value: 0};
    const throttle = new SecondarySourceThrottle(30_000, () => now.value);
    let fail = true;
    const run = runner({
        2: async () => {
            if (fail) {
                throw new Error("boom");
            }

            return {queueSize: 3};
        },
    });
    const wrapped = throttle.wrap(run, config(PRIMARY, SECONDARY));

    await assert.rejects(() => wrapped(SECONDARY), /boom/);
    fail = false;
    now.value = 1_000;
    assert.deepEqual(await wrapped(SECONDARY), {queueSize: 3});
    assert.deepEqual(run.calls, [2, 2]);
});

test("висящий запрос на следующем тике не дублируется", async () => {
    //Пока ответ не пришёл, второй тик получает тот же promise: grace-окно решит, ждать ли.
    let resolve: ((value: ServerQueryResult) => void) | undefined;
    const pending = new Promise<ServerQueryResult>(done => {
        resolve = done;
    });
    const run = runner({2: () => pending});
    const wrapped = new SecondarySourceThrottle(30_000, () => 0).wrap(run, config(PRIMARY, SECONDARY));

    const first = wrapped(SECONDARY);
    const second = wrapped(SECONDARY);

    resolve!({queueSize: 5});

    assert.deepEqual(await first, {queueSize: 5});
    assert.deepEqual(await second, {queueSize: 5});
    assert.deepEqual(run.calls, [2]);
});

test("retain забывает источники, которых больше нет", async () => {
    const now = {value: 0};
    const throttle = new SecondarySourceThrottle(30_000, () => now.value);
    const run = runner({2: async () => ({queueSize: 1})});
    const wrapped = throttle.wrap(run, config(PRIMARY, SECONDARY));

    await wrapped(SECONDARY);
    //Сервер пересобрали без второстепенного, потом вернули под тем же id: прошлый ответ протух.
    throttle.retain([config(PRIMARY)]);
    now.value = 1_000;
    await wrapped(SECONDARY);

    assert.deepEqual(run.calls, [2, 2]);
});
