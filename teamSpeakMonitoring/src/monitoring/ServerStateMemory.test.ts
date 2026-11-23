import test from "node:test";
import assert from "node:assert/strict";
import {lastConfirmedAt, restorableStates, savedStatesOf, type SavedServerState} from "./ServerStateMemory.js";
import type {ServerProbeSnapshot, ServerStatus} from "./ServerProbe.js";
import {serverConfigFixture} from "../test/serverFixtures.js";

const NOW = new Date("2026-11-24T12:00:00Z");
const SINCE = new Date("2026-11-24T08:00:00Z");

function snapshot(id: number, status: ServerStatus): ServerProbeSnapshot {
    return {config: serverConfigFixture({id}), status, failedChecks: 0, currentInfo: undefined, statusSince: SINCE};
}

function saved(serverId: number, confirmedAgoMs: number): SavedServerState {
    return {serverId, status: "online", since: SINCE, confirmedAt: new Date(NOW.getTime() - confirmedAgoMs)};
}

test("сохраняются online и offline с моментом начала; unknown — нет", () => {
    assert.deepEqual(savedStatesOf([snapshot(1, "online"), snapshot(2, "offline"), snapshot(3, "unknown")], NOW), [
        {serverId: 1, status: "online", since: SINCE, confirmedAt: NOW},
        {serverId: 2, status: "offline", since: SINCE, confirmedAt: NOW},
    ]);
});

test("восстанавливается только свежее: подтверждённое раньше срока ничего не говорит о сейчас", () => {
    const restored = restorableStates([saved(1, 30_000), saved(2, 600_000), saved(3, 600_001)], NOW, 600_000);

    assert.deepEqual([...restored.keys()], [1, 2]);
    assert.deepEqual(restored.get(1), {status: "online", since: SINCE});
});

test("простой бота оценивается по последнему подтверждению", () => {
    assert.equal(lastConfirmedAt([]), undefined);
    assert.deepEqual(lastConfirmedAt([saved(1, 90_000), saved(2, 30_000)]), new Date(NOW.getTime() - 30_000));
});
