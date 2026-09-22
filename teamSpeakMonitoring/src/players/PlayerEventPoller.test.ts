import test from "node:test";
import assert from "node:assert/strict";
import {PlayerEventPoller, type PlayerEventStore} from "./PlayerEventPoller.js";
import {PlayerObserverUnavailable, type PlayerEvent, type PlayerObserver} from "./PlayerObserver.js";
import {silentLogger} from "../test/silentLogger.js";

function event(id: number, playerId: number): PlayerEvent {
    return {
        id,
        type: "PLAYER_JOINED_SERVER",
        occurredAt: new Date("2026-09-11T12:00:00Z"),
        playerId,
        nickname: "Salat",
        serverId: 1,
        serverName: "[RU] #1",
        durationSeconds: undefined,
        payload: {},
        afterDataGap: false,
    };
}

//Хранилище в памяти: курсор и подписки, ничего больше.
function createStore(cursor: number | undefined, subscriptions: Record<number, number[]>): PlayerEventStore & {
    saved: number[];
} {
    const saved: number[] = [];

    return {
        saved,
        findCursor: async (): Promise<number | undefined> => cursor,
        saveCursor: async (lastEventId: number): Promise<void> => {
            saved.push(lastEventId);
        },
        findAllSubscribedPlayerIds: async (): Promise<number[]> => Object.keys(subscriptions).map(Number),
        findSubscribedChatIds: async (playerId: number): Promise<number[]> => subscriptions[playerId] ?? [],
    };
}

function createObserver(overrides: Partial<PlayerObserver> = {}): PlayerObserver {
    return {
        eventsHead: async (): Promise<number> => 0,
        events: async () => ({events: [], nextAfter: 0}),
        searchPlayers: async () => ({players: [], fuzzy: false}),
        playersByIds: async () => [],
        player: async () => undefined,
        sessions: async () => [],
        trackedServers: async () => [],
        dossier: async () => null,
        ...overrides,
    };
}

test("первый запуск начинает с конца ленты, а не с её начала", async () => {
    //Иначе после установки бота человек получил бы все входы за всё время наблюдения.
    const store = createStore(undefined, {});
    const asked: number[] = [];
    const observer = createObserver({
        eventsHead: async (): Promise<number> => 500,
        events: async (after: number) => {
            asked.push(after);
            return {events: [], nextAfter: after};
        },
    });

    await new PlayerEventPoller(observer, store, {deliver: async (): Promise<void> => undefined},
        {intervalMs: 1_000, pageSize: 100}, silentLogger).run();

    assert.deepEqual(asked, [500]);
    assert.deepEqual(store.saved, [500], "голова должна сохраниться сразу, а не после первой страницы");
});

test("события уходят подписчикам, курсор двигается", async () => {
    const store = createStore(10, {7: [100, 200]});
    const delivered: {chatId: number; eventId: number}[] = [];
    const observer = createObserver({
        events: async () => ({events: [event(11, 7), event(12, 7)], nextAfter: 12}),
    });

    await new PlayerEventPoller(observer, store, {
        deliver: async (chatId, item): Promise<void> => {
            delivered.push({chatId, eventId: item.id});
        },
    }, {intervalMs: 1_000, pageSize: 100}, silentLogger).run();

    assert.equal(delivered.length, 4, "два события × два подписчика");
    assert.deepEqual(store.saved, [12]);
});

test("курсор двигается и без подписок", async () => {
    //Иначе первая же подписка получила бы всю историю, накопившуюся за время простоя.
    const store = createStore(10, {});
    const observer = createObserver({events: async () => ({events: [], nextAfter: 40})});

    await new PlayerEventPoller(observer, store, {deliver: async (): Promise<void> => undefined},
        {intervalMs: 1_000, pageSize: 100}, silentLogger).run();

    assert.deepEqual(store.saved, [40]);
});

test("недоступность наблюдателя не двигает курсор и не роняет задачу", async () => {
    const store = createStore(10, {});
    const observer = createObserver({
        events: async (): Promise<never> => {
            throw new PlayerObserverUnavailable("сосед лёг");
        },
    });

    await new PlayerEventPoller(observer, store, {deliver: async (): Promise<void> => undefined},
        {intervalMs: 1_000, pageSize: 100}, silentLogger).run();

    assert.deepEqual(store.saved, [], "курсор остался на месте — те же события приедут следующим тиком");
});

test("отказ доставки одному чату не мешает остальным", async () => {
    const store = createStore(10, {7: [100, 200]});
    const delivered: number[] = [];
    const observer = createObserver({events: async () => ({events: [event(11, 7)], nextAfter: 11})});

    await new PlayerEventPoller(observer, store, {
        deliver: async (chatId): Promise<void> => {
            if (chatId === 100) {
                throw new Error("чат заблокировал бота");
            }

            delivered.push(chatId);
        },
    }, {intervalMs: 1_000, pageSize: 100}, silentLogger).run();

    assert.deepEqual(delivered, [200]);
    assert.deepEqual(store.saved, [11]);
});
