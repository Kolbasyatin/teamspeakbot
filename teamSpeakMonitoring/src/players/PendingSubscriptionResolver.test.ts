import test from "node:test";
import assert from "node:assert/strict";
import {PendingSubscriptionResolver, type PendingSubscriptionStore} from "./PendingSubscriptionResolver.js";
import type {ObservedPlayer, PlayerObserver, PlayerSearchResult} from "./PlayerObserver.js";
import {silentLogger} from "../test/silentLogger.js";

const NOW = new Date("2026-09-11T12:00:00Z");

function player(playerId: number, nickname: string, aliases: string[] = []): ObservedPlayer {
    return {
        playerId,
        bohemiaUserId: `uuid-${playerId}`,
        currentNickname: nickname,
        aliases: aliases.length > 0 ? aliases : [nickname],
        platforms: [],
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        online: undefined,
        lastServer: undefined,
        sessionsTotal: 1,
    };
}

function createStore(pending: {chatId: number; nickname: string}[]): PendingSubscriptionStore & {
    subscribed: {chatId: number; playerId: number}[];
    removed: string[];
    expiredDeleted: number;
} {
    const subscribed: {chatId: number; playerId: number}[] = [];
    const removed: string[] = [];
    let expiredDeleted = 0;

    return {
        subscribed,
        removed,
        get expiredDeleted(): number {
            return expiredDeleted;
        },
        findActivePending: async () => pending,
        deleteExpiredPending: async (): Promise<number> => {
            expiredDeleted += 1;
            return 0;
        },
        removePending: async (_chatId: number, nickname: string): Promise<void> => {
            removed.push(nickname);
        },
        subscribe: async (chatId: number, playerId: number): Promise<void> => {
            subscribed.push({chatId, playerId});
        },
    };
}

function createObserver(result: PlayerSearchResult): PlayerObserver {
    return {
        eventsHead: async (): Promise<number> => 0,
        events: async () => ({events: [], nextAfter: 0}),
        searchPlayers: async (): Promise<PlayerSearchResult> => result,
        playersByIds: async () => [],
        player: async () => undefined,
        sessions: async () => [],
        trackedServers: async () => [],
    };
}

function createResolver(observer: PlayerObserver, store: PendingSubscriptionStore, sent: string[]): PendingSubscriptionResolver {
    return new PendingSubscriptionResolver(observer, store, {
        deliver: async (_chatId: number, text: string): Promise<void> => {
            sent.push(text);
        },
    }, {intervalMs: 1_000}, silentLogger, () => NOW);
}

test("единственное точное совпадение превращается в подписку", async () => {
    const store = createStore([{chatId: 100, nickname: "Salat"}]);
    const sent: string[] = [];

    await createResolver(createObserver({players: [player(7, "Salat")], fuzzy: false}), store, sent).run();

    assert.deepEqual(store.subscribed, [{chatId: 100, playerId: 7}]);
    assert.deepEqual(store.removed, ["Salat"]);
    assert.equal(sent.length, 1);
});

test("подстрока точным совпадением не считается", async () => {
    //Поиск отдаёт и подстроки: «Salat» нашёл бы «Salatik» — это другой человек.
    const store = createStore([{chatId: 100, nickname: "Salat"}]);
    const sent: string[] = [];

    await createResolver(createObserver({players: [player(7, "Salatik")], fuzzy: false}), store, sent).run();

    assert.deepEqual(store.subscribed, [], "ожидание должно остаться висеть");
    assert.deepEqual(store.removed, []);
});

test("похожие (fuzzy) в автоподписку не идут", async () => {
    //Догадка о том, кого человек имел в виду, не повод подписать его на чужого.
    const store = createStore([{chatId: 100, nickname: "Salat"}]);
    const sent: string[] = [];

    await createResolver(createObserver({players: [player(7, "Salat")], fuzzy: true}), store, sent).run();

    assert.deepEqual(store.subscribed, []);
});

test("несколько тёзок — ожидание снимается и человека просят выбрать", async () => {
    const store = createStore([{chatId: 100, nickname: "Hello"}]);
    const sent: string[] = [];

    await createResolver(
        createObserver({players: [player(7, "Hello"), player(8, "Hello")], fuzzy: false}),
        store,
        sent,
    ).run();

    assert.deepEqual(store.subscribed, [], "выбирать между тёзками должен человек");
    assert.deepEqual(store.removed, ["Hello"], "иначе ожидание висело бы до истечения срока без шанса закрыться");
    assert.ok(sent[0]?.includes("/watch"), `в сообщении должна быть подсказка, что делать: ${sent[0]}`);
});

test("совпадение по старому нику тоже считается точным", async () => {
    const store = createStore([{chatId: 100, nickname: "OldName"}]);
    const sent: string[] = [];

    await createResolver(
        createObserver({players: [player(7, "NewName", ["NewName", "OldName"])], fuzzy: false}),
        store,
        sent,
    ).run();

    assert.deepEqual(store.subscribed, [{chatId: 100, playerId: 7}]);
});

test("просроченные ожидания чистятся на каждом тике", async () => {
    const store = createStore([]);
    const sent: string[] = [];

    await createResolver(createObserver({players: [], fuzzy: false}), store, sent).run();

    assert.equal(store.expiredDeleted, 1);
});
