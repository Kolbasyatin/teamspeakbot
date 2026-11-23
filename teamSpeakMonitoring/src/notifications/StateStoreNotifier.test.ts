import test from "node:test";
import assert from "node:assert/strict";
import {StateStoreNotifier} from "./StateStoreNotifier.js";
import type {SavedServerState, ServerStateStore} from "../monitoring/ServerStateMemory.js";
import type {ServerProbeSnapshot, ServerStatus} from "../monitoring/ServerProbe.js";
import {serverConfigFixture} from "../test/serverFixtures.js";

const NOW = new Date("2026-11-24T12:00:00Z");

function snapshot(id: number, status: ServerStatus): ServerProbeSnapshot {
    return {config: serverConfigFixture({id}), status, failedChecks: 0, currentInfo: undefined, statusSince: new Date(0)};
}

function recordingStore(): ServerStateStore & {saved: SavedServerState[][]} {
    const saved: SavedServerState[][] = [];

    return {
        saved,
        loadStates: async () => [],
        saveStates: async states => {
            saved.push([...states]);
        },
    };
}

test("периодическая публикация пишет все известные статусы разом, unknown пропускает", async () => {
    const store = recordingStore();

    await new StateStoreNotifier(store, () => NOW).notify({
        type: "serverStateRepublished",
        snapshots: [snapshot(1, "online"), snapshot(2, "unknown"), snapshot(3, "offline")],
    });

    assert.deepEqual(store.saved.map(batch => batch.map(state => `${state.serverId}:${state.status}`)), [["1:online", "3:offline"]]);
    assert.deepEqual(store.saved[0]?.[0]?.confirmedAt, NOW);
});

test("переход статуса пишется сразу, одним сервером", async () => {
    const store = recordingStore();

    await new StateStoreNotifier(store, () => NOW).notify({type: "serverOffline", snapshot: snapshot(7, "offline")});

    assert.deepEqual(store.saved.map(batch => batch.map(state => state.serverId)), [[7]]);
});

test("сохранять нечего — в хранилище не ходим", async () => {
    const store = recordingStore();

    await new StateStoreNotifier(store, () => NOW).notify({type: "serverStateRepublished", snapshots: [snapshot(1, "unknown")]});

    assert.deepEqual(store.saved, []);
});
