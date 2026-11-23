import test from "node:test";
import assert from "node:assert/strict";
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {insertTelegramChatFixture, migrateTestDatabase, truncateTestDatabase} from "../test/databaseTestUtils.js";
import {BroadcastRepository} from "./BroadcastRepository.js";
import {SubscriptionRepository} from "./SubscriptionRepository.js";
import {ChatHistoryRepository} from "./ChatHistoryRepository.js";
import {ChatDirectoryRepository} from "./ChatDirectoryRepository.js";

//Рассылки и списки рассылки (итерация 24, миграция 014).

let pool: Pool;
let repository: BroadcastRepository;

const ROOT = 100;
const VASYA = 555;
const PETYA = 777;
const GROUP = -1001234567890;

test.before(async () => {
    pool = createPool(dbConfig);
    repository = new BroadcastRepository(pool);

    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);

    for (const chatId of [ROOT, VASYA, PETYA]) {
        await insertTelegramChatFixture(pool, {chatId, title: `chat ${chatId}`});
    }
    await insertTelegramChatFixture(pool, {chatId: GROUP, type: "supergroup", title: "Клан"});
});

test.after(async () => {
    await pool.end();
});

test("списки: создать, повтор не дубль, добавить известных, неизвестный назван, удалить", async () => {
    assert.equal(await repository.createList("klan", "Клан EXD", ROOT), "created");
    assert.equal(await repository.createList("klan", undefined, ROOT), "exists");

    assert.deepEqual(await repository.includeChats("klan", [VASYA, GROUP, 999], ROOT), {changed: [VASYA, GROUP], unchanged: [], unknown: [999]});
    assert.deepEqual(await repository.includeChats("klan", [VASYA], ROOT), {changed: [], unchanged: [VASYA], unknown: []});
    assert.equal(await repository.includeChats("nosuch", [VASYA], ROOT), undefined);

    assert.deepEqual((await repository.listMembers("klan"))?.map(member => member.chatId).sort(), [GROUP, VASYA].sort());
    assert.deepEqual(await repository.excludeChats("klan", [VASYA, PETYA]), {changed: [VASYA], unchanged: [PETYA], unknown: []});

    assert.equal(await repository.deleteList("klan"), true);
    assert.equal(await repository.listMembers("klan"), undefined);
});

test("адресаты: all, unsorted, список и адресный чат; заблокировавшие — только адресно", async () => {
    await repository.createList("klan", undefined, ROOT);
    await repository.includeChats("klan", [VASYA, PETYA], ROOT);
    await pool.query("UPDATE telegram_chats SET blocked_at = NOW() WHERE chat_id = ?", [PETYA]);

    assert.deepEqual(await repository.resolveRecipients({kind: "all"}), [GROUP, ROOT, VASYA].sort((a, b) => a - b));
    assert.deepEqual(await repository.resolveRecipients({kind: "unsorted"}), [GROUP, ROOT].sort((a, b) => a - b));
    assert.deepEqual(await repository.resolveRecipients({kind: "list", name: "klan"}), [VASYA]);
    assert.deepEqual(await repository.resolveRecipients({kind: "chat", chatId: PETYA}), [PETYA], "адресно пишем и заблокировавшему");
    assert.deepEqual(await repository.resolveRecipients({kind: "chat", chatId: 999}), []);

    const overview = await repository.listsOverview();
    assert.deepEqual({all: overview.all, unsorted: overview.unsorted, blocked: overview.blocked}, {all: 3, unsorted: 2, blocked: 1});
    assert.deepEqual(overview.lists, [{name: "klan", description: undefined, members: 2}]);
});

test("рассылка: подтверждение и отмена атомарны, итог пишется, пометка «недоступен» ставится и снимается", async () => {
    const id = await repository.createBroadcast({
        authorUserId: ROOT, authorChatId: ROOT, content: {kind: "copy", fromChatId: ROOT, messageId: 42}, preview: "Вечером турнир", target: {kind: "list", name: "klan"},
    });

    assert.equal(await repository.startBroadcast(id), true);
    assert.equal(await repository.startBroadcast(id), false, "второй раз не запускается");
    assert.equal(await repository.cancelBroadcast(id), false, "идущую не отменить");

    await repository.recordDelivery(id, VASYA, {status: "delivered"});
    await repository.recordDelivery(id, PETYA, {status: "blocked", error: "403: Forbidden: bot was blocked by the user"});
    await repository.finishBroadcast(id, {recipients: 2, delivered: 1, blocked: 1, failed: 0});

    const stored = await repository.findBroadcast(id);
    assert.equal(stored?.status, "done");
    assert.deepEqual(stored?.content, {kind: "copy", fromChatId: ROOT, messageId: 42});
    assert.deepEqual(stored?.target, {kind: "list", name: "klan"});
    assert.equal(stored?.blocked, 1);

    const blocked = async (chatId: number): Promise<boolean> =>
        (await new ChatDirectoryRepository(pool).findChat(chatId))?.blocked ?? false;
    assert.equal(await blocked(PETYA), true);

    //Снова написал боту — значит, не заблокировал.
    await new SubscriptionRepository(pool).saveChat({chatId: PETYA, type: "private", title: "Петя"});
    assert.equal(await blocked(PETYA), false);
});

test("рассылка, оборванная рестартом, становится прерванной; ждущая подтверждения — нет", async () => {
    const sending = await repository.createBroadcast({authorUserId: ROOT, authorChatId: ROOT, content: {kind: "text", text: "a"}, preview: "a", target: {kind: "all"}});
    const pending = await repository.createBroadcast({authorUserId: ROOT, authorChatId: ROOT, content: {kind: "text", text: "b"}, preview: "b", target: {kind: "all"}});
    await repository.startBroadcast(sending);

    assert.equal(await repository.interruptUnfinished(), 1);
    assert.equal((await repository.findBroadcast(sending))?.status, "interrupted");
    assert.equal((await repository.findBroadcast(pending))?.status, "pending");
    assert.deepEqual((await repository.findRecentBroadcasts(10)).map(broadcast => broadcast.id), [sending], "ждущие подтверждения в журнал не идут");
});

test("полученная рассылка — в истории чата, списки чата — в его шапке", async () => {
    await repository.createList("klan", undefined, ROOT);
    await repository.includeChats("klan", [VASYA], ROOT);
    const id = await repository.createBroadcast({authorUserId: ROOT, authorChatId: ROOT, content: {kind: "text", text: "Привет"}, preview: "Привет", target: {kind: "list", name: "klan"}});
    await repository.recordDelivery(id, VASYA, {status: "failed", error: "400: Bad Request"});

    const history = new ChatHistoryRepository(pool);
    assert.equal(await history.countHistory(VASYA), 1);
    assert.deepEqual(await history.findHistoryPage(VASYA, 10, 0), [{
        kind: "broadcast", at: (await history.findHistoryPage(VASYA, 10, 0))[0]?.at, broadcastId: id, preview: "Привет", status: "failed", error: "400: Bad Request",
    }]);

    assert.deepEqual((await new ChatDirectoryRepository(pool).findChat(VASYA))?.lists, ["klan"]);
});
