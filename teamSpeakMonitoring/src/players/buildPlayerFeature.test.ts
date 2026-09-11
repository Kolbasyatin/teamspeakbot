import test from "node:test";
import assert from "node:assert/strict";
import {buildPlayerFeature, type PlayerStore} from "./buildPlayerFeature.js";
import {silentLogger} from "../test/silentLogger.js";

const STORE = {} as unknown as PlayerStore;
const CHATS = {saveChat: async (): Promise<void> => undefined};
const SENDER = {send: async (): Promise<void> => undefined};

const PROPERTIES = {
    baseUrl: "http://observer.test",
    apiToken: "secret",
    timeoutMs: 1_000,
    eventIntervalMs: 15_000,
    eventPageSize: 200,
    pendingIntervalMs: 300_000,
    pendingTtlMs: 1_000,
    pendingLimit: 5,
};

test("настроенный наблюдатель даёт набор команд и две фоновые задачи", () => {
    const feature = buildPlayerFeature(PROPERTIES, STORE, CHATS, SENDER, silentLogger);

    assert.ok(feature);
    assert.equal(feature.tasks.length, 2, "лента событий и резолвер отложенных подписок");
    assert.ok(feature.commands.describe().length > 0, "команды должны попадать в меню Telegram");
});

test("без адреса тема выключена целиком", () => {
    assert.equal(buildPlayerFeature({...PROPERTIES, baseUrl: ""}, STORE, CHATS, SENDER, silentLogger), undefined);
});

test("без токена тема тоже выключена", () => {
    //С адресом, но без токена сосед отвечает 401 на каждый запрос, и лента засыпала бы лог
    //предупреждениями каждые пятнадцать секунд.
    assert.equal(buildPlayerFeature({...PROPERTIES, apiToken: ""}, STORE, CHATS, SENDER, silentLogger), undefined);
});
