import test from "node:test";
import assert from "node:assert/strict";
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {
    insertMonitoredServerFixture,
    insertTelegramChatFixture,
    migrateTestDatabase,
    truncateTestDatabase,
} from "../test/databaseTestUtils.js";
import {SubscriptionRepository} from "./SubscriptionRepository.js";

//Проверяется только то, что действительно про SQL: что записалось, что отобралось и что уносит
//каскад. Правил здесь нет — репозиторий ничего не решает, — поэтому и проверять кроме хранения
//нечего.

let pool: Pool;
let repository: SubscriptionRepository;

//Свой сервер под каждый тест: id автоинкрементный, и жёстко зашитый номер разъехался бы
//с реальностью после первого же прогона.
async function insertServer(name: string): Promise<number> {
    return insertMonitoredServerFixture(pool, {
        name,
        gameAddress: "127.0.0.1:2001",
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}}],
    });
}

test.before(async () => {
    pool = createPool(dbConfig);
    repository = new SubscriptionRepository(pool);

    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);
});

test("чат сохраняется и читается обратно", async () => {
    await repository.saveChat({chatId: 12345, type: "private", title: undefined});

    assert.deepEqual(await repository.findChat(12345), {
        chatId: 12345,
        type: "private",
        //NULL в базе наружу отдаётся как undefined: домен про NULL не знает.
        title: undefined,
    });
});

test("отрицательный chat_id группы сохраняется без потерь", async () => {
    //Ради этого случая колонка объявлена знаковым bigint: у групп и каналов id отрицательные.
    await repository.saveChat({chatId: -1001234567890, type: "supergroup", title: "Клан"});

    const chat = await repository.findChat(-1001234567890);

    assert.equal(chat?.chatId, -1001234567890);
    assert.equal(chat?.title, "Клан");
});

test("повторное сохранение обновляет чат, а не создаёт второй", async () => {
    await repository.saveChat({chatId: 777, type: "group", title: "Старое имя"});
    await repository.saveChat({chatId: 777, type: "supergroup", title: "Новое имя"});

    const chat = await repository.findChat(777);

    assert.equal(chat?.type, "supergroup");
    assert.equal(chat?.title, "Новое имя");

    const [row] = await pool.query("SELECT COUNT(*) AS total FROM telegram_chats");
    assert.equal(Number(row.total), 1);
});

test("подписка читается с обеих сторон", async () => {
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});

    await repository.subscribe(100, serverId);

    assert.deepEqual(await repository.findSubscribedServerIds(100), [serverId]);
    assert.deepEqual(await repository.findSubscriberChatIds(serverId, "availability"), [100]);
});

test("повторная подписка не создаёт дубля и не падает", async () => {
    //Двойной тап по кнопке «подписаться» — обычное дело; вторая строка означала бы два сообщения
    //на каждое падение сервера.
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});

    await repository.subscribe(100, serverId);
    await repository.subscribe(100, serverId);

    assert.deepEqual(await repository.findSubscriberChatIds(serverId, "availability"), [100]);
});

test("отписка удаляет только свою пару", async () => {
    const firstServer = await insertServer("First");
    const secondServer = await insertServer("Second");
    await insertTelegramChatFixture(pool, {chatId: 100});
    await insertTelegramChatFixture(pool, {chatId: 200});

    await repository.subscribe(100, firstServer);
    await repository.subscribe(100, secondServer);
    await repository.subscribe(200, firstServer);

    await repository.unsubscribe(100, firstServer);

    assert.deepEqual(await repository.findSubscribedServerIds(100), [secondServer]);
    assert.deepEqual(await repository.findSubscriberChatIds(firstServer, "availability"), [200]);
});

test("отписка от того, на что не подписан, не ошибка", async () => {
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});

    await repository.unsubscribe(100, serverId);

    assert.deepEqual(await repository.findSubscribedServerIds(100), []);
});

test("удаление сервера уносит его подписки", async () => {
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});
    await repository.subscribe(100, serverId);

    await pool.query("DELETE FROM monitored_servers WHERE id = ?", [serverId]);

    assert.deepEqual(await repository.findSubscribedServerIds(100), []);
});

test("удаление чата уносит его подписки", async () => {
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});
    await repository.subscribe(100, serverId);

    await pool.query("DELETE FROM telegram_chats WHERE chat_id = ?", [100]);

    assert.deepEqual(await repository.findSubscriberChatIds(serverId, "availability"), []);
});

test("подписки чужого чата не приезжают", async () => {
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});
    await insertTelegramChatFixture(pool, {chatId: 200});

    await repository.subscribe(200, serverId);

    assert.deepEqual(await repository.findSubscribedServerIds(100), []);
});

test("несуществующий чат не читается", async () => {
    assert.equal(await repository.findChat(999), undefined);
});

test("подписка включает оба типа уведомлений", async () => {
    //Человек подписывается, чтобы знать, а не чтобы потом искать настройки.
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});

    await repository.subscribe(100, serverId);

    assert.deepEqual(
        (await repository.findSubscriptionEvents(100, serverId)).toSorted(),
        ["availability", "roundFinish"],
    );
});

test("повторная подписка не возвращает снятые галочки", async () => {
    //Иначе двойное нажатие в списке молча включало бы обратно то, что человек только что выключил.
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});

    await repository.subscribe(100, serverId);
    await repository.disableEvent(100, serverId, "roundFinish");
    await repository.subscribe(100, serverId);

    assert.deepEqual(await repository.findSubscriptionEvents(100, serverId), ["availability"]);
});

test("рассылка спрашивает подписчиков по типу", async () => {
    //Главное свойство механизма: следит за сервером — не значит хочет знать про каждый конец раунда.
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});
    await insertTelegramChatFixture(pool, {chatId: 200});

    await repository.subscribe(100, serverId);
    await repository.subscribe(200, serverId);
    await repository.disableEvent(200, serverId, "roundFinish");

    assert.deepEqual(await repository.findSubscriberChatIds(serverId, "availability"), [100, 200]);
    assert.deepEqual(await repository.findSubscriberChatIds(serverId, "roundFinish"), [100]);
});

test("выключенный тип включается обратно", async () => {
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});

    await repository.subscribe(100, serverId);
    await repository.disableEvent(100, serverId, "availability");
    await repository.enableEvent(100, serverId, "availability");

    assert.deepEqual(
        (await repository.findSubscriptionEvents(100, serverId)).toSorted(),
        ["availability", "roundFinish"],
    );
});

test("отписка уносит типы вместе с подпиской", async () => {
    const serverId = await insertServer("Server");
    await insertTelegramChatFixture(pool, {chatId: 100});

    await repository.subscribe(100, serverId);
    await repository.unsubscribe(100, serverId);

    assert.deepEqual(await repository.findSubscriptionEvents(100, serverId), []);

    const [row] = await pool.query("SELECT COUNT(*) AS total FROM server_subscription_events");
    assert.equal(Number(row.total), 0);
});

test.after(async () => {
    await pool.end();
});
