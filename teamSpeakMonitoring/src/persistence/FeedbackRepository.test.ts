import test from "node:test";
import assert from "node:assert/strict";
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {insertTelegramChatFixture, migrateTestDatabase, truncateTestDatabase} from "../test/databaseTestUtils.js";
import {FeedbackRepository} from "./FeedbackRepository.js";

let pool: Pool;
let repository: FeedbackRepository;

test.before(async () => {
    pool = createPool(dbConfig);
    repository = new FeedbackRepository(pool);

    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);
});

test.after(async () => {
    await pool.end();
});

test("сообщение сохраняется и находится по доставке", async () => {
    await insertTelegramChatFixture(pool, {chatId: 555});

    const id = await repository.save({chatId: 555, userId: 555, author: "Вася", text: "Добавьте EXD"});

    await repository.addDelivery(id, 100, 7);

    assert.deepEqual(await repository.findByDelivery(100, 7), {id, chatId: 555, text: "Добавьте EXD"});
});

test("доставка ищется по паре чат + сообщение: тот же id в другом чате — не она", async () => {
    await insertTelegramChatFixture(pool, {chatId: 555});

    const id = await repository.save({chatId: 555, userId: undefined, author: "Вася", text: "x"});

    await repository.addDelivery(id, 100, 7);

    assert.equal(await repository.findByDelivery(200, 7), undefined);
    assert.equal(await repository.findByDelivery(100, 8), undefined);
});

test("частота считается по чату и по окну", async () => {
    await insertTelegramChatFixture(pool, {chatId: 555});
    await insertTelegramChatFixture(pool, {chatId: 556});

    await repository.save({chatId: 555, userId: undefined, author: "a", text: "1"});
    await repository.save({chatId: 555, userId: undefined, author: "a", text: "2"});
    await repository.save({chatId: 556, userId: undefined, author: "b", text: "3"});
    //Старое сообщение за окном не считается.
    await pool.query("UPDATE feedback_messages SET created_at = NOW() - INTERVAL 1 HOUR WHERE text = '1'");

    assert.equal(await repository.countRecent(555, 600), 1);
    assert.equal(await repository.countRecent(556, 600), 1);
});

test("сообщения и доставки уходят вместе с чатом", async () => {
    await insertTelegramChatFixture(pool, {chatId: 555});

    const id = await repository.save({chatId: 555, userId: undefined, author: "a", text: "x"});

    await repository.addDelivery(id, 100, 7);
    await pool.query("DELETE FROM telegram_chats WHERE chat_id = 555");

    assert.equal(await repository.findByDelivery(100, 7), undefined);
});
