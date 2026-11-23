import test from "node:test";
import assert from "node:assert/strict";
import {StatusDeliveryJournal, type StatusDelivery, type StatusDeliveryStore} from "./StatusDeliveryJournal.js";
import {silentLogger} from "../test/silentLogger.js";

function store(rows: StatusDelivery[], failSave = false): StatusDeliveryStore & {saved: StatusDelivery[]} {
    const saved: StatusDelivery[] = [];

    return {
        saved,
        loadDeliveries: async () => rows,
        saveDelivery: async delivery => {
            if (failSave) {
                throw new Error("база недоступна");
            }
            saved.push(delivery);
        },
    };
}

test("память раздаётся по чатам: каждому — его доставки, незнакомому — пустая", async () => {
    const journal = new StatusDeliveryJournal(store([
        {chatId: 100, serverId: 1, delivered: "serverOnline"},
        {chatId: 100, serverId: 2, delivered: "serverOffline"},
        {chatId: -200, serverId: 1, delivered: "serverOffline"},
    ]), silentLogger);

    assert.equal(await journal.load(), 3);
    assert.deepEqual([...journal.memoryFor(100).restored], [["1", "serverOnline"], ["2", "serverOffline"]]);
    assert.deepEqual([...journal.memoryFor(-200).restored], [["1", "serverOffline"]]);
    assert.equal(journal.memoryFor(300).restored.size, 0);
});

test("доставка сохраняется с чатом и сервером; отказ базы не бросает — сообщение уже ушло", async () => {
    const working = store([]);
    await new StatusDeliveryJournal(working, silentLogger).memoryFor(100).remember("7", "serverOnline");

    assert.deepEqual(working.saved, [{chatId: 100, serverId: 7, delivered: "serverOnline"}]);

    const broken = new StatusDeliveryJournal(store([], true), silentLogger);
    await assert.doesNotReject(broken.memoryFor(100).remember("7", "serverOnline"));
});
