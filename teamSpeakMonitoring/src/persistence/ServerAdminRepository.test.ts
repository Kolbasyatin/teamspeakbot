import test from "node:test";
import assert from "node:assert/strict";
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {insertTelegramChatFixture, migrateTestDatabase, truncateTestDatabase} from "../test/databaseTestUtils.js";
import {ServerAdminRepository} from "./ServerAdminRepository.js";
import {ServerRepository} from "./ServerRepository.js";
import {SubscriptionRepository} from "./SubscriptionRepository.js";

//Только хранение: что записалось, что прочиталось, что уходит каскадом. Правила администрирования
//(черновик, один primary) проверяет ServerAdmin.test.ts без базы.

let pool: Pool;
let repository: ServerAdminRepository;

const A2S = {type: "a2s", host: "37.48.253.41", port: 17771, timeout: 5000} as const;

test.before(async () => {
    pool = createPool(dbConfig);
    repository = new ServerAdminRepository(pool);

    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);
});

test.after(async () => {
    await pool.end();
});

test("новый сервер создаётся выключенным и читается обратно", async () => {
    const id = await repository.createServer("#1 ARMA", "37.48.253.41:2001");

    assert.deepEqual(await repository.findServer(id), {
        id,
        name: "#1 ARMA",
        gameAddress: "37.48.253.41:2001",
        enabled: false,
        subscriberCount: 0,
        sources: [],
    });
});

test("правка сервера меняет только названные колонки", async () => {
    const id = await repository.createServer("Old", "1.2.3.4:2001");

    await repository.updateServer(id, {name: "New"});

    const server = await repository.findServer(id);

    assert.equal(server?.name, "New");
    assert.equal(server?.gameAddress, "1.2.3.4:2001");
    assert.equal(server?.enabled, false);
});

test("источник пишется так, что его читает опрос: query_type совпадает с конфигом", async () => {
    //Главная проверка записи: то, что сохранила админка, должно приезжать в список опроса.
    const serverId = await repository.createServer("S", "37.48.253.41:2001");
    const sourceId = await repository.createSource(serverId, {role: "primary", priority: 0, enabled: true, config: A2S});

    await repository.updateServer(serverId, {enabled: true});
    await insertTelegramChatFixture(pool, {chatId: 1});
    await new SubscriptionRepository(pool).subscribe(1, serverId);

    const [monitored] = await new ServerRepository(pool).findMonitored();

    assert.deepEqual(monitored?.sources, [{id: sourceId, role: "primary", priority: 0, query: A2S}]);
    assert.equal(monitored?.invalidSources, undefined);
});

test("правка конфига источника меняет и query_config, и query_type", async () => {
    const serverId = await repository.createServer("S", "37.48.253.41:2001");
    const sourceId = await repository.createSource(serverId, {role: "primary", priority: 0, enabled: true, config: A2S});

    await repository.updateSource(sourceId, {
        priority: 3,
        config: {type: "bohemia", hostAddress: "37.48.253.41:2001", timeout: 4000},
    });

    const source = await repository.findSource(sourceId);

    assert.equal(source?.priority, 3);
    assert.equal(source?.queryType, "bohemia");
    assert.deepEqual(source?.config, {type: "bohemia", hostAddress: "37.48.253.41:2001", timeout: 4000});
});

test("непригодный источник виден администратору с причиной и сырым конфигом", async () => {
    const serverId = await repository.createServer("S", "37.48.253.41:2001");

    await pool.query(
        `INSERT INTO server_query_sources (server_id, role, priority, query_type, query_config, enabled)
         VALUES (?, 'primary', 0, 'a2s', '{"type":"a2s","host":"h"}', TRUE)`,
        [serverId],
    );

    const [source] = (await repository.findServer(serverId))?.sources ?? [];

    assert.equal(source?.config, undefined);
    assert.match(source?.problem ?? "", /port/);
    assert.deepEqual(source?.raw, {type: "a2s", host: "h"});
});

test("источники сервера идут по приоритету, включая выключенные", async () => {
    const serverId = await repository.createServer("S", "37.48.253.41:2001");
    const second = await repository.createSource(serverId, {role: "secondary", priority: 5, enabled: false, config: A2S});
    const first = await repository.createSource(serverId, {role: "primary", priority: 0, enabled: true, config: A2S});

    const sources = (await repository.findServer(serverId))?.sources ?? [];

    assert.deepEqual(sources.map(source => [source.id, source.enabled]), [[first, true], [second, false]]);
});

test("список администратора показывает всё и считает включённые источники и primary", async () => {
    const draft = await repository.createServer("A draft", "1.1.1.1:1");
    const ready = await repository.createServer("B ready", "2.2.2.2:2");

    await repository.createSource(ready, {role: "primary", priority: 0, enabled: true, config: A2S});
    await repository.createSource(ready, {role: "secondary", priority: 1, enabled: false, config: A2S});
    await repository.updateServer(ready, {enabled: true});

    assert.deepEqual(await repository.findSummaryPage("", 10, 0), [
        {id: draft, name: "A draft", gameAddress: "1.1.1.1:1", enabled: false, enabledSourceCount: 0, enabledPrimaryCount: 0},
        {id: ready, name: "B ready", gameAddress: "2.2.2.2:2", enabled: true, enabledSourceCount: 1, enabledPrimaryCount: 1},
    ]);
    assert.equal(await repository.countSummaries("draft"), 1);
});

test("удаление сервера уносит источники и подписки", async () => {
    const serverId = await repository.createServer("S", "37.48.253.41:2001");
    const sourceId = await repository.createSource(serverId, {role: "primary", priority: 0, enabled: true, config: A2S});

    await insertTelegramChatFixture(pool, {chatId: 1});
    await new SubscriptionRepository(pool).subscribe(1, serverId);
    assert.equal((await repository.findServer(serverId))?.subscriberCount, 1);

    await repository.deleteServer(serverId);

    assert.equal(await repository.findServer(serverId), undefined);
    assert.equal(await repository.findSource(sourceId), undefined);
    assert.deepEqual(await new SubscriptionRepository(pool).findSubscribedServerIds(1), []);
});

test("удаление источника не трогает сервер", async () => {
    const serverId = await repository.createServer("S", "37.48.253.41:2001");
    const sourceId = await repository.createSource(serverId, {role: "primary", priority: 0, enabled: true, config: A2S});

    await repository.deleteSource(sourceId);

    assert.deepEqual((await repository.findServer(serverId))?.sources, []);
});
