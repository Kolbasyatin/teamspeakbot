import test from "node:test";
import assert from "node:assert/strict";
import {summarizeForLog} from "./LogNotifier.js";
import {snapshotFixture} from "../test/serverFixtures.js";

test("тихая неудача меняет выжимку журнала, хотя статус и игроки те же", () => {
    //Выжимка — ключ дедупликации журнала. Не попади failedChecks в неё, неудача до порога offline
    //не дала бы строки в логе, и короткий простой сервера было бы не увидеть вовсе.
    const healthy = snapshotFixture({players: 120});
    const stumbled = {...healthy, failedChecks: 1};

    assert.notEqual(
        JSON.stringify(summarizeForLog([healthy])),
        JSON.stringify(summarizeForLog([stumbled])),
    );
    assert.deepEqual(summarizeForLog([stumbled]), [{
        id: 1,
        name: "Server 1",
        status: "online",
        failedChecks: 1,
        players: 120,
        maxPlayers: 64,
        queueSize: undefined,
    }]);
});
