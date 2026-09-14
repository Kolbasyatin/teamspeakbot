import test from "node:test";
import assert from "node:assert/strict";
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {
    insertTelegramChatFixture,
    migrateTestDatabase,
    truncateTestDatabase,
} from "../test/databaseTestUtils.js";
import {PlayerSubscriptionRepository} from "./PlayerSubscriptionRepository.js";

//Проверяется только то, что действительно про SQL: что записалось, что отобралось, что уносит
//каскад и что идемпотентно. Правил здесь нет — репозиторий ничего не решает.

let pool: Pool;
let repository: PlayerSubscriptionRepository;

const CHAT = 12_345;
const OTHER_CHAT = 67_890;
//Идентификатор чужого сервиса: внешнего ключа на него нет, любое число допустимо.
const PLAYER = 4_812;

test.before(async () => {
    pool = createPool(dbConfig);
    repository = new PlayerSubscriptionRepository(pool);

    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);
    await insertTelegramChatFixture(pool, {chatId: CHAT});
    await insertTelegramChatFixture(pool, {chatId: OTHER_CHAT});
});

test.after(async () => {
    await pool.end();
});

test("подписка записывается и читается с обеих сторон", async () => {
    await repository.subscribe(CHAT, PLAYER);

    assert.deepEqual(await repository.findSubscribedPlayerIds(CHAT), [PLAYER]);
    assert.deepEqual(await repository.findSubscribedChatIds(PLAYER), [CHAT]);
});

test("повторная подписка не создаёт вторую строку", async () => {
    //Иначе двойное нажатие кнопки приводило бы к двум сообщениям на каждое событие.
    await repository.subscribe(CHAT, PLAYER);
    await repository.subscribe(CHAT, PLAYER);

    assert.deepEqual(await repository.findSubscribedPlayerIds(CHAT), [PLAYER]);
});

test("отписка убирает только свою строку", async () => {
    await repository.subscribe(CHAT, PLAYER);
    await repository.subscribe(OTHER_CHAT, PLAYER);

    await repository.unsubscribe(CHAT, PLAYER);

    assert.deepEqual(await repository.findSubscribedPlayerIds(CHAT), []);
    assert.deepEqual(await repository.findSubscribedChatIds(PLAYER), [OTHER_CHAT]);
});

test("список всех отслеживаемых игроков не дублируется", async () => {
    //Он уезжает фильтром в запрос ленты: дубли раздували бы строку запроса без всякой пользы.
    await repository.subscribe(CHAT, PLAYER);
    await repository.subscribe(OTHER_CHAT, PLAYER);

    assert.deepEqual(await repository.findAllSubscribedPlayerIds(), [PLAYER]);
});

test("удаление чата уносит его подписки", async () => {
    await repository.subscribe(CHAT, PLAYER);

    await pool.query("DELETE FROM telegram_chats WHERE chat_id = ?", [CHAT]);

    assert.deepEqual(await repository.findSubscribedChatIds(PLAYER), []);
});

test("курсора нет, пока его не сохранили", async () => {
    assert.equal(await repository.findCursor(), undefined);
});

test("курсор двигается только вперёд", async () => {
    //Запоздавший ответ предыдущего тика не должен отбрасывать курсор назад: те же события
    //приехали бы повторно.
    await repository.saveCursor(100);
    await repository.saveCursor(50);

    assert.equal(await repository.findCursor(), 100);

    await repository.saveCursor(150);

    assert.equal(await repository.findCursor(), 150);
});

test("ожидание по нику продлевается, а не дублируется", async () => {
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 600_000);

    await repository.addPending(CHAT, "Salat", soon);
    await repository.addPending(CHAT, "Salat", later);

    assert.deepEqual(await repository.findPendingByChat(CHAT), ["Salat"]);
    assert.equal(await repository.countPendingByChat(CHAT), 1);
});

test("просроченные ожидания не отдаются и удаляются", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    await repository.addPending(CHAT, "Просроченный", past);
    await repository.addPending(CHAT, "Живой", future);

    const active = await repository.findActivePending(new Date());

    assert.deepEqual(active.map(item => item.nickname), ["Живой"]);
    assert.equal(await repository.deleteExpiredPending(new Date()), 1);
    assert.deepEqual(await repository.findPendingByChat(CHAT), ["Живой"]);
});

test("ожидание снимается по нику", async () => {
    await repository.addPending(CHAT, "Salat", new Date(Date.now() + 60_000));

    await repository.removePending(CHAT, "Salat");

    assert.deepEqual(await repository.findPendingByChat(CHAT), []);
});

test("ожидание по нику не различает регистр", () => {
    //Человек набирает ник по памяти: «Salat» и «salat» — один и тот же ник, и второй вызов
    //не должен заводить второе ожидание. Обеспечивается коллацией колонки (utf8mb4_unicode_ci),
    //поэтому и проверяется здесь, в тесте против настоящей MariaDB.
    return (async (): Promise<void> => {
        const future = new Date(Date.now() + 60_000);

        await repository.addPending(CHAT, "Добрый Фей", future);
        await repository.addPending(CHAT, "добрый фей", future);

        assert.equal(await repository.countPendingByChat(CHAT), 1, "разный регистр — одно ожидание");
        assert.deepEqual(await repository.findPendingByChat(CHAT), ["Добрый Фей"], "сохранилось первое написание");

        await repository.removePending(CHAT, "ДОБРЫЙ ФЕЙ");

        assert.deepEqual(await repository.findPendingByChat(CHAT), [], "снимается независимо от регистра");
    })();
});
