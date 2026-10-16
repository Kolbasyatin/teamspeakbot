import test from "node:test";
import assert from "node:assert/strict";
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {insertTelegramChatFixture, migrateTestDatabase, truncateTestDatabase} from "../test/databaseTestUtils.js";
import {RoleRepository} from "./RoleRepository.js";
import {PlayerSubscriptionRepository} from "./PlayerSubscriptionRepository.js";

//Только хранение: что записалось, что прочиталось, что уносит каскад и что однократно.
//Кто вправе выдать роль, решает AccessControl, и проверяется это там, без базы.

let pool: Pool;
let repository: RoleRepository;

const GROUP = -1001234567890;

test.before(async () => {
    pool = createPool(dbConfig);
    repository = new RoleRepository(pool);

    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);
});

test.after(async () => {
    await pool.end();
});

test("выданная роль читается обратно, повторная выдача — не вторая строка", async () => {
    await insertTelegramChatFixture(pool, {chatId: 100});

    assert.equal(await repository.grant(100, "ROLE_PLAYER_USER", 1, "из клана"), "granted");
    assert.equal(await repository.grant(100, "ROLE_PLAYER_USER", 1, undefined), "alreadyGranted");
    assert.deepEqual(await repository.findRoles(100), ["ROLE_PLAYER_USER"]);
});

test("у группы id отрицательный — и роль ей выдаётся", async () => {
    await insertTelegramChatFixture(pool, {chatId: GROUP, type: "supergroup", title: "Клан"});

    assert.equal(await repository.grant(GROUP, "ROLE_TS_VIEW", 1, undefined), "granted");
    assert.deepEqual(await repository.findRoles(GROUP), ["ROLE_TS_VIEW"]);

    const [assignment] = await repository.findAssignments();

    assert.equal(assignment?.chatId, GROUP);
    assert.equal(assignment?.chatTitle, "Клан");
    assert.equal(assignment?.grantedBy, 1);
});

test("чату, который боту не писал, роль не выдаётся", async () => {
    assert.equal(await repository.grant(555, "ROLE_PLAYER_USER", 1, undefined), "unknownChat");
});

test("отзыв удаляет назначение и сообщает, было ли оно", async () => {
    await insertTelegramChatFixture(pool, {chatId: 100});
    await repository.grant(100, "ROLE_PLAYER_USER", 1, undefined);

    assert.equal(await repository.revoke(100, "ROLE_PLAYER_USER"), true);
    assert.equal(await repository.revoke(100, "ROLE_PLAYER_USER"), false);
    assert.deepEqual(await repository.findRoles(100), []);
});

test("роль по умолчанию выдаётся один раз за всю историю чата", async () => {
    await insertTelegramChatFixture(pool, {chatId: 100});

    assert.equal(await repository.grantDefaultOnce(100, "ROLE_SERVER_USER"), true);
    await repository.revoke(100, "ROLE_SERVER_USER");

    //Отобранная роль не возвращается повторным /start.
    assert.equal(await repository.grantDefaultOnce(100, "ROLE_SERVER_USER"), false);
    assert.deepEqual(await repository.findRoles(100), []);
});

test("роли уходят вместе с чатом", async () => {
    await insertTelegramChatFixture(pool, {chatId: 100});
    await repository.grant(100, "ROLE_PLAYER_USER", 1, undefined);

    await pool.query("DELETE FROM telegram_chats WHERE chat_id = ?", [100]);

    assert.deepEqual(await repository.findAssignments(), []);
});

test("очистка подписок на игроков забирает и подписки, и ожидания только этого чата", async () => {
    const players = new PlayerSubscriptionRepository(pool);

    await insertTelegramChatFixture(pool, {chatId: 100});
    await insertTelegramChatFixture(pool, {chatId: 200});
    await players.subscribe(100, 7);
    await players.addPending(100, "БЛИНК", new Date(Date.now() + 60_000));
    await players.subscribe(200, 7);

    await players.removeAllForChat(100);

    assert.deepEqual(await players.findSubscribedPlayerIds(100), []);
    assert.deepEqual(await players.findPendingByChat(100), []);
    assert.deepEqual(await players.findSubscribedPlayerIds(200), [7]);
});

test("назначения одного чата — только его, включая роли, которых нет в коде", async () => {
    await insertTelegramChatFixture(pool, {chatId: 100, title: "Вася"});
    await insertTelegramChatFixture(pool, {chatId: 200});
    await repository.grant(100, "ROLE_PLAYER_USER", 1, "из клана");
    await repository.grant(200, "ROLE_TS_VIEW", 1, undefined);
    await pool.query("INSERT INTO telegram_chat_roles (chat_id, role) VALUES (100, 'ROLE_SUPER_USER')");

    const assignments = await repository.findAssignmentsByChat(100);

    assert.deepEqual(assignments.map(item => item.role), ["ROLE_PLAYER_USER", "ROLE_SUPER_USER"]);
    assert.equal(assignments[0]?.note, "из клана");
    assert.equal(assignments[0]?.chatTitle, "Вася");
    assert.deepEqual(await repository.findAssignmentsByChat(555), []);
});
