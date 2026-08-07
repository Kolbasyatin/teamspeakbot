import test from "node:test";
import assert from "node:assert/strict"
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {
    insertMonitoredServerFixture,
    insertTelegramChatFixture,
    migrateTestDatabase,
    truncateTestDatabase,
} from "../test/databaseTestUtils.js";
import {ServerRepository} from "./ServerRepository.js";

//Здесь остаётся только то, что действительно про SQL: какие строки отбираются и как они
//превращаются в StoredServer. Правила «кто главный источник» и «кого опрашивать нечем»
//проверяются в buildMonitorConfigs.test.ts — без живой БД, потому что к ней они не относятся.

//Подписчик, от имени которого подписаны серверы в тестах. Кто именно подписан, репозиторию
//безразлично — он проверяет только факт наличия подписки, — поэтому чат везде один.
const SUBSCRIBER_CHAT_ID = 100;

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
    await insertTelegramChatFixture(pool, {chatId: SUBSCRIBER_CHAT_ID});
});

test("сервер без подписок не опрашивается", async () => {
    //Главное правило этой выдачи: опрашиваем не «всё включённое», а «то, что кому-то нужно».
    await insertMonitoredServerFixture(pool, {
        name: "Nobody subscribed",
        gameAddress: "127.0.0.1:2001",
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
    });

    assert.deepEqual(await repository.findMonitored(), []);
});

test("сервер с несколькими подписчиками приезжает одной строкой", async () => {
    //EXISTS, а не JOIN: иначе сервер задублировался бы по числу подписчиков и получил бы
    //столько же probe.
    await insertTelegramChatFixture(pool, {chatId: 200});

    await insertMonitoredServerFixture(pool, {
        name: "Popular server",
        gameAddress: "127.0.0.1:2001",
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
        subscribers: [SUBSCRIBER_CHAT_ID, 200],
    });

    const servers = await repository.findMonitored();

    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.sources.length, 1);
});

test("отбираются только включённые серверы", async () => {
    await insertMonitoredServerFixture(pool, {
        name: "Enabled server",
        gameAddress: "127.0.0.1:2001",
        enabled: true,
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
        subscribers: [SUBSCRIBER_CHAT_ID],
    });

    await insertMonitoredServerFixture(pool, {
        name: "Disabled server",
        gameAddress: "127.0.0.1:2002",
        enabled: false,
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17778, timeout: 1000}}],
        subscribers: [SUBSCRIBER_CHAT_ID],
    });

    const servers = await repository.findMonitored();

    assert.deepEqual(servers.map(server => server.name), ["Enabled server"]);
});

test("источник приезжает с разобранным конфигом, ролью и приоритетом", async () => {
    await insertMonitoredServerFixture(pool, {
        name: "REST server",
        gameAddress: "https://example.com",
        sources: [{
            query: {type: "rest", url: "https://example.com/status", timeout: 1000, fields: {players: "players", maxPlayers: "maxPlayers"}},
            role: "secondary",
            priority: 4,
        }],
        subscribers: [SUBSCRIBER_CHAT_ID],
    });

    const source = (await repository.findMonitored())[0]?.sources[0];

    assert.equal(source?.role, "secondary");
    assert.equal(source?.priority, 4);
    assert.deepEqual(source?.query, {
        type: "rest",
        url: "https://example.com/status",
        timeout: 1000,
        fields: {players: "players", maxPlayers: "maxPlayers"},
    });
});

test("отключённый источник не попадает в выдачу", async () => {
    await insertMonitoredServerFixture(pool, {
        name: "Server with disabled source",
        gameAddress: "127.0.0.1:2001",
        sources: [
            {query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}, role: "primary"},
            {
                query: {type: "rest", url: "https://example.com/status", timeout: 1000, fields: {players: "players", maxPlayers: "maxPlayers"}},
                role: "secondary",
                priority: 1,
                enabled: false,
            },
        ],
        subscribers: [SUBSCRIBER_CHAT_ID],
    });

    const servers = await repository.findMonitored();

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
        subscribers: [SUBSCRIBER_CHAT_ID],
    });

    await insertMonitoredServerFixture(pool, {
        name: "Enabled server",
        gameAddress: "127.0.0.1:2001",
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
        subscribers: [SUBSCRIBER_CHAT_ID],
    });

    const servers = await repository.findMonitored();

    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.sources.length, 1);
    assert.equal(servers[0]?.sources[0]?.query.type, "a2s");
});

test("источники неподписанного сервера не приезжают вместе с чужими", async () => {
    //То же самое, но по второму условию отбора: оно тоже обязано стоять в обоих запросах.
    await insertMonitoredServerFixture(pool, {
        name: "Nobody subscribed",
        gameAddress: "127.0.0.1:2002",
        sources: [{query: {type: "rest", url: "https://example.com/status", timeout: 1000, fields: {players: "players"}}}],
    });

    await insertMonitoredServerFixture(pool, {
        name: "Subscribed",
        gameAddress: "127.0.0.1:2001",
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
        subscribers: [SUBSCRIBER_CHAT_ID],
    });

    const servers = await repository.findMonitored();

    assert.equal(servers.length, 1);
    assert.deepEqual(servers[0]?.sources.map(source => source.query.type), ["a2s"]);
});

test("сервер без включённых источников отдаётся с пустым списком, а не пропадает", async () => {
    //Решение выбросить такой сервер принимает домен, поэтому увидеть его он обязан.
    await insertMonitoredServerFixture(pool, {
        name: "Server with everything disabled",
        gameAddress: "127.0.0.1:2001",
        sources: [
            {query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}, enabled: false},
        ],
        subscribers: [SUBSCRIBER_CHAT_ID],
    });

    const servers = await repository.findMonitored();

    assert.equal(servers.length, 1);
    assert.deepEqual(servers[0]?.sources, []);
});

test("отписка последнего подписчика убирает сервер из опроса", async () => {
    //Проверяемый результат итерации: список опроса пересобирается из подписок, а не из enabled.
    const serverId = await insertMonitoredServerFixture(pool, {
        name: "Server",
        gameAddress: "127.0.0.1:2001",
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
        subscribers: [SUBSCRIBER_CHAT_ID],
    });

    assert.equal((await repository.findMonitored()).length, 1);

    await pool.query("DELETE FROM server_subscriptions WHERE server_id = ?", [serverId]);

    assert.deepEqual(await repository.findMonitored(), []);
});

test("каталог показывает включённые серверы, в том числе без подписок", async () => {
    //Отбор здесь ДРУГОЙ, чем у findMonitored, и это главное свойство каталога: подписаться
    //не на что, если показывать только уже подписанное.
    await insertMonitoredServerFixture(pool, {
        name: "Никто не подписан",
        gameAddress: "127.0.0.1:2001",
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
    });

    await insertMonitoredServerFixture(pool, {
        name: "Скрытый",
        gameAddress: "127.0.0.1:2002",
        enabled: false,
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17778, timeout: 1000}}],
    });

    const servers = await repository.findCatalogPage("", 10, 0);

    assert.deepEqual(servers.map(server => server.name), ["Никто не подписан"]);
    assert.equal(await repository.countCatalog(""), 1);
});

test("каталог ищет по части имени и считает найденное", async () => {
    for (const name of ["ARMA первый", "ARMA второй", "Другой"]) {
        await insertMonitoredServerFixture(pool, {
            name,
            gameAddress: "127.0.0.1:2001",
            sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
        });
    }

    assert.deepEqual(
        (await repository.findCatalogPage("ARMA", 10, 0)).map(server => server.name),
        ["ARMA второй", "ARMA первый"],
    );
    assert.equal(await repository.countCatalog("ARMA"), 2);
});

test("каталог режется на страницы в порядке имён", async () => {
    for (const name of ["В", "А", "Б"]) {
        await insertMonitoredServerFixture(pool, {
            name,
            gameAddress: "127.0.0.1:2001",
            sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
        });
    }

    assert.deepEqual((await repository.findCatalogPage("", 2, 0)).map(server => server.name), ["А", "Б"]);
    assert.deepEqual((await repository.findCatalogPage("", 2, 2)).map(server => server.name), ["В"]);
});

test("серверы по списку id читаются даже отключённые", async () => {
    //Сервер могли скрыть из каталога уже после подписки — человек обязан увидеть его в своём
    //списке, хотя бы чтобы отписаться.
    const hidden = await insertMonitoredServerFixture(pool, {
        name: "Скрытый",
        gameAddress: "127.0.0.1:2002",
        enabled: false,
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17778, timeout: 1000}}],
    });

    assert.deepEqual((await repository.findByIds([hidden])).map(server => server.name), ["Скрытый"]);
});

test("пустой список id не роняет запрос", async () => {
    //IN () — синтаксическая ошибка, а не пустая выдача.
    assert.deepEqual(await repository.findByIds([]), []);
});

test.after(async () => {
    await pool.end();
});
