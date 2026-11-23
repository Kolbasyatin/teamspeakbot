import test from "node:test";
import assert from "node:assert/strict";
import {BroadcastRunner} from "./BroadcastRunner.js";
import type {BroadcastStore, DeliveryCounts, DeliveryOutcome, StoredBroadcast} from "./Broadcasts.js";
import {silentLogger} from "../test/silentLogger.js";

const BROADCAST: StoredBroadcast = {
    id: 5, authorUserId: 1, authorChatId: 1, content: {kind: "text", text: "Сервер EXD #3 добавлен"}, preview: "Сервер EXD #3 добавлен",
    target: {kind: "list", name: "klan"}, status: "sending", recipients: 0, delivered: 0, blocked: 0, failed: 0,
    createdAt: new Date(0), finishedAt: undefined,
};

function store(recipients: number[], failRecordFor: number[] = []): BroadcastStore & {recorded: string[]; finished: DeliveryCounts[]} {
    const recorded: string[] = [];
    const finished: DeliveryCounts[] = [];

    return {
        recorded,
        finished,
        resolveRecipients: async () => recipients,
        recordDelivery: async (_id: number, chatId: number, outcome: DeliveryOutcome) => {
            if (failRecordFor.includes(chatId)) {
                throw new Error("база недоступна");
            }
            recorded.push(`${chatId}:${outcome.status}`);
        },
        finishBroadcast: async (_id: number, counts: DeliveryCounts) => {
            finished.push(counts);
        },
    } as unknown as BroadcastStore & {recorded: string[]; finished: DeliveryCounts[]};
}

const OUTCOMES: Record<number, DeliveryOutcome> = {
    1: {status: "delivered"},
    2: {status: "blocked", error: "403: Forbidden: bot was blocked by the user"},
    3: {status: "failed", error: "400: Bad Request"},
};

test("каждому адресату — своя попытка, итог в базу, счётчики в конце и отчёт автору", async () => {
    const recipients = [1, 2, 3, 1];
    const repository = store(recipients);
    const reports: DeliveryCounts[] = [];
    const runner = new BroadcastRunner(repository, {deliver: async chatId => OUTCOMES[chatId] ?? {status: "delivered"}}, async (_b, counts) => {
        reports.push(counts);
    }, silentLogger);

    const counts = await runner.run(BROADCAST);

    assert.deepEqual(counts, {recipients: 4, delivered: 2, blocked: 1, failed: 1});
    assert.deepEqual(repository.recorded, ["1:delivered", "2:blocked", "3:failed", "1:delivered"]);
    assert.deepEqual(repository.finished, [counts]);
    assert.deepEqual(reports, [counts]);
});

test("сбой записи итога одного чата не останавливает рассылку остальным", async () => {
    const repository = store([1, 3, 2], [3]);
    const delivered: number[] = [];
    const runner = new BroadcastRunner(repository, {
        deliver: async chatId => {
            delivered.push(chatId);
            return {status: "delivered"};
        },
    }, async () => undefined, silentLogger);

    await runner.run(BROADCAST);

    assert.deepEqual(delivered, [1, 3, 2]);
    assert.deepEqual(repository.finished.map(counts => counts.delivered), [3]);
});
