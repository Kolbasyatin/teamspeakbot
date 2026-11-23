import test from "node:test";
import assert from "node:assert/strict";
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {insertTelegramChatFixture, migrateTestDatabase, truncateTestDatabase} from "../test/databaseTestUtils.js";
import {ChatHistoryRepository} from "./ChatHistoryRepository.js";
import {FeedbackRepository} from "./FeedbackRepository.js";
import {RoleRepository} from "./RoleRepository.js";
import {ChatDirectoryRepository} from "./ChatDirectoryRepository.js";

//Журнал команд, ответы на обратную связь и лента истории чата (итерация 23).

let pool: Pool;
let history: ChatHistoryRepository;
let feedback: FeedbackRepository;
let roles: RoleRepository;

const CHAT = 555;
const OTHER = 777;

test.before(async () => {
    pool = createPool(dbConfig);
    history = new ChatHistoryRepository(pool);
    feedback = new FeedbackRepository(pool);
    roles = new RoleRepository(pool);

    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);
    //telegram_command_log не привязан к чатам внешним ключом, каскад его не чистит.
    await pool.query("DELETE FROM telegram_command_log");
});

test.after(async () => {
    await pool.end();
});

async function setTime(table: string, id: number, at: string): Promise<void> {
    await pool.query(`UPDATE ${table} SET created_at = ? WHERE id = ?`, [at, id]);
}

async function lastId(table: string): Promise<number> {
    const [row] = await pool.query<{id: number | bigint}[]>(`SELECT MAX(id) AS id FROM ${table}`);
    return Number(row?.id);
}

test("лента собирает команды, права, обращения и ответы этого чата, новые сверху", async () => {
    await insertTelegramChatFixture(pool, {chatId: CHAT, title: "Вася"});
    await insertTelegramChatFixture(pool, {chatId: OTHER});

    await history.saveCommand({chatId: CHAT, userId: CHAT, kind: "command", name: "start", arguments: undefined, permission: "ROLE_ANONYMOUS", allowed: true});
    await setTime("telegram_command_log", await lastId("telegram_command_log"), "2026-11-24 10:00:00");

    await roles.grantDefaultOnce(CHAT, "ROLE_SERVER_USER");
    await setTime("role_events", await lastId("role_events"), "2026-11-24 10:00:01");

    const feedbackId = await feedback.save({chatId: CHAT, userId: CHAT, author: "Вася", text: "Добавьте EXD"});
    await setTime("feedback_messages", feedbackId, "2026-11-24 11:00:00");

    await feedback.addReply({feedbackId, adminChatId: 1, adminUserId: 1, text: "Добавили", delivered: true});
    await setTime("feedback_replies", await lastId("feedback_replies"), "2026-11-24 12:00:00");

    await history.saveCommand({chatId: CHAT, userId: CHAT, kind: "button", name: "ch:1", arguments: undefined, permission: undefined, allowed: false});
    await setTime("telegram_command_log", await lastId("telegram_command_log"), "2026-11-24 13:00:00");

    //Чужой чат в ленту не попадает.
    await history.saveCommand({chatId: OTHER, userId: OTHER, kind: "command", name: "who", arguments: undefined, permission: "ROLE_TS_VIEW", allowed: false});

    assert.equal(await history.countHistory(CHAT), 5);

    const page = await history.findHistoryPage(CHAT, 10, 0);

    assert.deepEqual(page.map(entry => entry.kind), ["button", "reply", "feedback", "grant", "command"]);
    assert.deepEqual(page[0], {kind: "button", at: page[0]?.at, userId: CHAT, name: "ch:1", arguments: undefined, known: false, allowed: false});
    assert.deepEqual(page[1], {kind: "reply", at: page[1]?.at, feedbackId, text: "Добавили", delivered: true});
    assert.deepEqual(page[3], {kind: "grant", at: page[3]?.at, role: "ROLE_SERVER_USER", actorUserId: undefined, note: "по умолчанию при /start"});
    assert.deepEqual(page[4], {kind: "command", at: page[4]?.at, userId: CHAT, name: "start", arguments: undefined, known: true, allowed: true});

    assert.deepEqual((await history.findHistoryPage(CHAT, 2, 2)).map(entry => entry.kind), ["feedback", "grant"]);
});

test("/feedback: обращения новые сверху, у каждого все его ответы по порядку", async () => {
    await insertTelegramChatFixture(pool, {chatId: CHAT});

    const first = await feedback.save({chatId: CHAT, userId: CHAT, author: "Вася", text: "первое"});
    const second = await feedback.save({chatId: CHAT, userId: CHAT, author: "Вася", text: "второе"});
    await setTime("feedback_messages", first, "2026-11-24 10:00:00");
    await setTime("feedback_messages", second, "2026-11-24 11:00:00");

    await feedback.addReply({feedbackId: first, adminChatId: 1, adminUserId: undefined, text: "раз", delivered: true});
    await feedback.addReply({feedbackId: first, adminChatId: 1, adminUserId: 1, text: "два", delivered: false});

    assert.equal(await feedback.countFeedback(), 2);

    const threads = await feedback.findFeedbackPage(10, 0);

    assert.deepEqual(threads.map(thread => thread.text), ["второе", "первое"]);
    assert.deepEqual(threads[0]?.replies, []);
    assert.deepEqual(threads[1]?.replies.map(reply => [reply.text, reply.delivered, reply.adminUserId]), [
        ["раз", true, undefined],
        ["два", false, 1],
    ]);
});

test("один чат читается для шапки истории, незнакомый — нет", async () => {
    const directory = new ChatDirectoryRepository(pool);
    await insertTelegramChatFixture(pool, {chatId: CHAT, title: "Вася"});

    assert.equal((await directory.findChat(CHAT))?.title, "Вася");
    assert.equal(await directory.findChat(OTHER), undefined);
});
