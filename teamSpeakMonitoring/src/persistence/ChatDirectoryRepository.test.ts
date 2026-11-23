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
import {ChatDirectoryRepository} from "./ChatDirectoryRepository.js";

let pool: Pool;
let repository: ChatDirectoryRepository;

const GROUP = -1001234567890;

test.before(async () => {
    pool = createPool(dbConfig);
    repository = new ChatDirectoryRepository(pool);

    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);
});

test.after(async () => {
    await pool.end();
});

async function chatAt(chatId: number, createdAt: string, extra: {type?: "private" | "supergroup"; title?: string} = {}): Promise<void> {
    await insertTelegramChatFixture(pool, {chatId, ...extra});
    await pool.query("UPDATE telegram_chats SET created_at = ? WHERE chat_id = ?", [createdAt, chatId]);
}

async function role(chatId: number, name: string): Promise<void> {
    await pool.query("INSERT INTO telegram_chat_roles (chat_id, role) VALUES (?, ?)", [chatId, name]);
}

test("пустая база: ноль чатов и пустая страница", async () => {
    assert.deepEqual(await repository.countChats(), {total: 0, private: 0});
    assert.deepEqual(await repository.findChatPage(20, 0), []);
});

test("чаты новые сверху, с ролями и подписками; подписки не размножаются ролями", async () => {
    await chatAt(100, "2026-09-01 10:00:00", {title: "старый"});
    await chatAt(GROUP, "2026-10-01 10:00:00", {type: "supergroup", title: "Клан"});
    await chatAt(200, "2026-11-01 10:00:00");

    await role(100, "ROLE_SERVER_USER");
    await role(100, "ROLE_PLAYER_USER");
    await role(GROUP, "ROLE_TS_USER");
    await role(GROUP, "ROLE_SERVER_USER");

    //Две роли и две подписки у группы: при JOIN по подпискам вышло бы 4 подписки и роли дублями.
    for (const name of ["#1", "#2"]) {
        await insertMonitoredServerFixture(pool, {
            name,
            gameAddress: `127.0.0.1:${name === "#1" ? 2001 : 2002}`,
            sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17771, timeout: 5000}}],
            subscribers: [GROUP],
        });
    }

    assert.deepEqual(await repository.countChats(), {total: 3, private: 2});

    const page = await repository.findChatPage(20, 0);

    assert.deepEqual(page.map(chat => chat.chatId), [200, GROUP, 100]);
    assert.deepEqual(page.map(chat => chat.roles), [[], ["ROLE_SERVER_USER", "ROLE_TS_USER"], ["ROLE_PLAYER_USER", "ROLE_SERVER_USER"]]);
    assert.deepEqual(page.map(chat => chat.serverSubscriptions), [0, 2, 0]);
    assert.deepEqual(page.map(chat => chat.title), [undefined, "Клан", "старый"]);
    assert.equal(page[1]?.type, "supergroup");
});

test("листание без пропусков и повторов, даже при одинаковом времени появления", async () => {
    for (const chatId of [1, 2, 3, 4, 5]) {
        await chatAt(chatId, "2026-10-16 12:00:00");
    }

    const first = await repository.findChatPage(2, 0);
    const second = await repository.findChatPage(2, 2);
    const third = await repository.findChatPage(2, 4);

    assert.deepEqual([...first, ...second, ...third].map(chat => chat.chatId), [5, 4, 3, 2, 1]);
});
