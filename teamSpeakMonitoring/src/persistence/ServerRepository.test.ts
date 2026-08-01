import test from "node:test";
import assert from "node:assert/strict"
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {insertMonitoredServerFixture, migrateTestDatabase, truncateTestDatabase} from "../test/databaseTestUtils.js";
import {ServerRepository} from "./ServerRepository.js";

//Здесь остаётся только то, что действительно про SQL: какие строки отбираются и как они
//превращаются в StoredServer. Правила «кто главный источник» и «кого опрашивать нечем»
//проверяются в buildMonitorConfigs.test.ts — без живой БД, потому что к ней они не относятся.

let pool: Pool;
let repository: ServerRepository;

test.before(async () => {
    pool = createPool(dbConfig)
    repository = new ServerRepository(pool);

    //Схема приводится тем же мигратором, что в проде: своего DDL у тестов больше нет.
    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);
});

test("отбираются только включённые серверы", async () => {
    await insertMonitoredServerFixture(pool, {
        name: "Enabled server",
        gameAddress: "127.0.0.1:2001",
        enabled: true,
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
    });

    await insertMonitoredServerFixture(pool, {
        name: "Disabled server",
        gameAddress: "127.0.0.1:2002",
        enabled: false,
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17778, timeout: 1000}}],
    });

    const servers = await repository.findAllEnabled();

    assert.deepEqual(servers.map(server => server.name), ["Enabled server"]);
});

test("источник приезжает с разобранным конфигом, ролью и приоритетом", async () => {
    await insertMonitoredServerFixture(pool, {
        name: "REST server",
        gameAddress: "https://example.com",
        sources: [{
            query: {type: "rest", url: "https://example.com/status", timeout: 1000},
            role: "secondary",
            priority: 4,
        }],
    });

    const source = (await repository.findAllEnabled())[0]?.sources[0];

    assert.equal(source?.role, "secondary");
    assert.equal(source?.priority, 4);
    assert.deepEqual(source?.query, {
        type: "rest",
        url: "https://example.com/status",
        timeout: 1000,
    });
});

test("отключённый источник не попадает в выдачу", async () => {
    await insertMonitoredServerFixture(pool, {
        name: "Server with disabled source",
        gameAddress: "127.0.0.1:2001",
        sources: [
            {query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}, role: "primary"},
            {
                query: {type: "rest", url: "https://example.com/status", timeout: 1000},
                role: "secondary",
                priority: 1,
                enabled: false,
            },
        ],
    });

    const servers = await repository.findAllEnabled();

    assert.deepEqual(servers[0]?.sources.map(source => source.query.type), ["a2s"]);
});

test("источники отключённого сервера не приезжают вместе с чужими", async () => {
    //Источники отбираются отдельным запросом, поэтому условие enabled нужно и на сервере тоже:
    //без JOIN по monitored_servers сюда попали бы источники выключенных серверов.
    await insertMonitoredServerFixture(pool, {
        name: "Disabled server",
        gameAddress: "127.0.0.1:2002",
        enabled: false,
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17778, timeout: 1000}}],
    });

    await insertMonitoredServerFixture(pool, {
        name: "Enabled server",
        gameAddress: "127.0.0.1:2001",
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
    });

    const servers = await repository.findAllEnabled();

    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.sources.length, 1);
    assert.equal(servers[0]?.sources[0]?.query.type, "a2s");
});

test("сервер без включённых источников отдаётся с пустым списком, а не пропадает", async () => {
    //Решение выбросить такой сервер принимает домен, поэтому увидеть его он обязан.
    await insertMonitoredServerFixture(pool, {
        name: "Server with everything disabled",
        gameAddress: "127.0.0.1:2001",
        sources: [
            {query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}, enabled: false},
        ],
    });

    const servers = await repository.findAllEnabled();

    assert.equal(servers.length, 1);
    assert.deepEqual(servers[0]?.sources, []);
});

test.after(async () => {
    await pool.end();
});
