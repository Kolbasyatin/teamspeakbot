import test from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {pollServerSources, type SourceQueryRunner} from "./pollServerSources.js";
import type {ServerMonitorConfig, ServerQuerySource} from "./MonitoredServer.js";
import type {ServerQueryResult} from "./ServerQuery.js";

//Тесты про время. Значения задержек подобраны с большим запасом друг относительно друга,
//чтобы результат не зависел от точности таймеров: проверяются исходы, а не миллисекунды.

function source(id: number, priority: number): ServerQuerySource {
    return {
        id,
        role: id === 1 ? "primary" : "secondary",
        priority,
        query: {type: "a2s", host: "127.0.0.1", port: 17770 + id, timeout: 1000},
    };
}

//Главный — всегда источник с id 1: так тесты читаются без лишнего параметра.
function config(...sources: ServerQuerySource[]): ServerMonitorConfig {
    const primarySource = sources.find(item => item.id === 1);

    assert.ok(primarySource, "фикстура обязана содержать источник с id 1");

    return {id: 100, name: "Test server", gameAddress: "127.0.0.1:2001", sources, primarySource};
}

function after<T>(delayMs: number, value: T): Promise<T> {
    return new Promise(resolve => setTimeout(() => resolve(value), delayMs));
}

//Сценарий опроса: что и когда отвечает каждый источник.
function runner(
    plan: Record<number, () => Promise<ServerQueryResult | undefined>>,
): SourceQueryRunner {
    return source => {
        const step = plan[source.id];

        assert.ok(step, `в сценарии нет источника ${source.id}`);

        return step();
    };
}

function createLogger(): Logger & {warnings: unknown[]} {
    const warnings: unknown[] = [];

    return {
        warnings,
        debug: () => {},
        info: () => {},
        warn: (payload: unknown) => warnings.push(payload),
        error: () => {},
    } as unknown as Logger & {warnings: unknown[]};
}

test("единственный источник: его ответ и есть статус и данные", async () => {
    const result = await pollServerSources(
        config(source(1, 0)),
        runner({1: async () => ({players: 10, maxPlayers: 64})}),
        50,
        createLogger(),
    );

    assert.deepEqual(result, {alive: true, info: {players: 10, maxPlayers: 64}});
});

test("молчание главного источника — это offline, независимо от остальных", async () => {
    const result = await pollServerSources(
        config(source(1, 0), source(2, 1)),
        runner({
            1: async () => undefined,
            2: async () => ({players: 42, maxPlayers: 64}),
        }),
        50,
        createLogger(),
    );

    //Данные второстепенного есть и получены мгновенно, но тик считается неудачным целиком:
    //«сервер вроде не отвечает, но игроков мы обновили» — не то поведение, которое нужно.
    assert.deepEqual(result, {alive: false, info: {}});
});

test("данные второстепенного источника попадают в результат", async () => {
    const result = await pollServerSources(
        config(source(1, 0), source(2, 1)),
        runner({
            1: async () => ({players: 10}),
            2: async () => ({maxPlayers: 64}),
        }),
        50,
        createLogger(),
    );

    assert.deepEqual(result.info, {players: 10, maxPlayers: 64});
});

test("при совпадении поля выигрывает более приоритетный источник", async () => {
    //sources приезжают уже отсортированными — это гарантия buildMonitorConfigs, и порядок
    //массива здесь равен порядку приоритетов: сначала priority 1, потом priority 5.
    const result = await pollServerSources(
        config(source(2, 1), source(1, 5)),
        runner({
            1: async () => ({players: 10}),
            2: async () => ({players: 3, maxPlayers: 64}),
        }),
        50,
        createLogger(),
    );

    //Главный — это про статус, а не про данные: по данным его обходит источник с priority 1.
    assert.deepEqual(result.info, {players: 3, maxPlayers: 64});
});

test("второстепенный, не уложившийся в окно, не участвует в слиянии", async () => {
    const result = await pollServerSources(
        config(source(1, 0), source(2, 1)),
        runner({
            1: async () => ({players: 10}),
            2: () => after(400, {maxPlayers: 64}),
        }),
        30,
        createLogger(),
    );

    assert.deepEqual(result.info, {players: 10}, "медленный источник не задержал тик");
});

test("окно отсчитывается от ответа главного, а не от начала опроса", async () => {
    //Ключевое правило. Главный отвечает на 120 мс, второстепенный на 100 мс, окно — 40 мс.
    //Считай окно от старта, оно истекло бы на 40 мс и данные второстепенного пропали бы,
    //хотя тот ответил раньше главного.
    const result = await pollServerSources(
        config(source(1, 0), source(2, 1)),
        runner({
            1: () => after(120, {players: 10}),
            2: () => after(100, {maxPlayers: 64}),
        }),
        40,
        createLogger(),
    );

    assert.deepEqual(result.info, {players: 10, maxPlayers: 64});
});

test("медленный главный не отваливается из-за быстрых второстепенных", async () => {
    const result = await pollServerSources(
        config(source(1, 0), source(2, 1)),
        runner({
            1: () => after(150, {players: 10}),
            2: async () => ({maxPlayers: 64}),
        }),
        20,
        createLogger(),
    );

    //Окно 20 мс истекло бы задолго до ответа главного, будь оно общим бюджетом опроса.
    assert.deepEqual(result, {alive: true, info: {players: 10, maxPlayers: 64}});
});

test("источники опрашиваются параллельно, а не по очереди", async () => {
    const started = new Date().getTime();
    const result = await pollServerSources(
        config(source(1, 0), source(2, 1), source(3, 2)),
        runner({
            1: () => after(100, {players: 10}),
            2: () => after(100, {maxPlayers: 64}),
            3: () => after(100, {}),
        }),
        200,
        createLogger(),
    );
    const elapsed = new Date().getTime() - started;

    assert.deepEqual(result.info, {players: 10, maxPlayers: 64});
    assert.ok(elapsed < 250, `три источника по 100 мс заняли ${elapsed} мс, последовательно было бы 300+`);
});

test("быстрый ответ не заставляет ждать окно целиком", async () => {
    //Проверяет, что таймер окна гасится: иначе тик длился бы graceMs даже когда все ответили сразу.
    const started = new Date().getTime();
    await pollServerSources(
        config(source(1, 0), source(2, 1)),
        runner({
            1: async () => ({players: 10}),
            2: async () => ({maxPlayers: 64}),
        }),
        5_000,
        createLogger(),
    );
    const elapsed = new Date().getTime() - started;

    assert.ok(elapsed < 200, `опрос занял ${elapsed} мс при окне 5000 мс`);
});

test("отказ второстепенного источника гасится и попадает в лог", async () => {
    const logger = createLogger();
    const result = await pollServerSources(
        config(source(1, 0), source(2, 1)),
        runner({
            1: async () => ({players: 10}),
            2: async () => {
                throw new Error("Unsupported query type: carrier-pigeon");
            },
        }),
        50,
        logger,
    );

    //Молча глотать нельзя: иначе опечатка в query_type второстепенного выглядит как
    //«сервер просто не отдаёт это поле» и не находится никогда.
    assert.deepEqual(result, {alive: true, info: {players: 10}});
    assert.equal(logger.warnings.length, 1);
});

test("отказ второстепенного до ответа главного не роняет опрос", async () => {
    //Второстепенный падает, пока мы ещё ждём главного. Без .catch, навешенного при старте,
    //это был бы unhandled rejection.
    const logger = createLogger();
    const result = await pollServerSources(
        config(source(1, 0), source(2, 1)),
        runner({
            1: () => after(80, {players: 10}),
            2: async () => {
                throw new Error("мгновенный отказ");
            },
        }),
        50,
        logger,
    );

    assert.deepEqual(result, {alive: true, info: {players: 10}});
    assert.equal(logger.warnings.length, 1);
});

test("отказ главного источника пробрасывается наружу", async () => {
    //Неизвестный query_type у главного означает, что сервер опрашивать нечем. Это не «нет данных»,
    //а поломанная конфигурация, и ловит её Scheduler, а не слияние.
    await assert.rejects(
        pollServerSources(
            config(source(1, 0), source(2, 1)),
            runner({
                1: async () => {
                    throw new Error("Unsupported query type: carrier-pigeon");
                },
                2: async () => ({maxPlayers: 64}),
            }),
            50,
            createLogger(),
        ),
        /Unsupported query type/,
    );
});
