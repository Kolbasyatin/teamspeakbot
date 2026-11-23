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
import {ServerStateRepository} from "./ServerStateRepository.js";
import {StatusDeliveryRepository} from "./StatusDeliveryRepository.js";

//Память между рестартами (итерация 22): статусы серверов и доставки «упал/поднялся».

let pool: Pool;
let states: ServerStateRepository;
let deliveries: StatusDeliveryRepository;

test.before(async () => {
    pool = createPool(dbConfig);
    states = new ServerStateRepository(pool);
    deliveries = new StatusDeliveryRepository(pool);

    await migrateTestDatabase();
});

test.beforeEach(async () => {
    await truncateTestDatabase(pool);
});

test.after(async () => {
    await pool.end();
});

async function server(port: number): Promise<number> {
    return insertMonitoredServerFixture(pool, {
        name: `#${port}`,
        gameAddress: `127.0.0.1:${port}`,
        sources: [{query: {type: "a2s", host: "127.0.0.1", port: 17771, timeout: 5000}}],
    });
}

const at = (iso: string): Date => new Date(iso);

test("статус сервера сохраняется и читается обратно с миллисекундами", async () => {
    const id = await server(2001);

    await states.saveStates([{serverId: id, status: "online", since: at("2026-11-24T08:00:00.123Z"), confirmedAt: at("2026-11-24T12:00:00.456Z")}]);

    assert.deepEqual(await states.loadStates(), [
        {serverId: id, status: "online", since: at("2026-11-24T08:00:00.123Z"), confirmedAt: at("2026-11-24T12:00:00.456Z")},
    ]);
});

test("запоздавшая запись со старым подтверждением не затирает новый статус", async () => {
    const id = await server(2001);

    await states.saveStates([{serverId: id, status: "offline", since: at("2026-11-24T12:00:05Z"), confirmedAt: at("2026-11-24T12:00:05Z")}]);
    await states.saveStates([{serverId: id, status: "online", since: at("2026-11-24T08:00:00Z"), confirmedAt: at("2026-11-24T12:00:00Z")}]);

    const [state] = await states.loadStates();
    assert.equal(state?.status, "offline");
    assert.deepEqual(state?.confirmedAt, at("2026-11-24T12:00:05Z"));
});

test("статус удалённого сервера не пишется и пакет не роняет; удаление уносит сохранённое", async () => {
    const id = await server(2001);

    await states.saveStates([
        {serverId: 999_999, status: "online", since: at("2026-11-24T08:00:00Z"), confirmedAt: at("2026-11-24T12:00:00Z")},
        {serverId: id, status: "online", since: at("2026-11-24T08:00:00Z"), confirmedAt: at("2026-11-24T12:00:00Z")},
    ]);
    assert.deepEqual((await states.loadStates()).map(state => state.serverId), [id]);

    await pool.query("DELETE FROM monitored_servers WHERE id = ?", [id]);
    assert.deepEqual(await states.loadStates(), []);
});

test("доставка — ячейка на пару (чат, сервер): новое значение перезаписывает старое", async () => {
    const id = await server(2001);
    await insertTelegramChatFixture(pool, {chatId: -1001234567890, type: "supergroup", title: "Клан"});

    await deliveries.saveDelivery({chatId: -1001234567890, serverId: id, delivered: "serverOnline"});
    await deliveries.saveDelivery({chatId: -1001234567890, serverId: id, delivered: "serverOffline"});

    assert.deepEqual(await deliveries.loadDeliveries(), [{chatId: -1001234567890, serverId: id, delivered: "serverOffline"}]);

    await pool.query("DELETE FROM telegram_chats WHERE chat_id = ?", [-1001234567890]);
    assert.deepEqual(await deliveries.loadDeliveries(), [], "удалённый чат уносит свою память");
});
