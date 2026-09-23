import test from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import type {TeamSpeak} from "ts3-nodejs-library";
import type {TeamSpeakProperties} from "../properties.js";
import {TeamSpeakConnection, TeamSpeakTimeoutError} from "./TeamSpeakConnection.js";

const silentLogger = {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}} as unknown as Logger;
const properties = {} as TeamSpeakProperties;

interface FakeTeamSpeak {
    id: number;
    forceQuits: number;
}

//Ровно то, что соединение трогает у библиотеки: выбор сервера, подписка на close, forceQuit.
function fakeConnector(): {connects: FakeTeamSpeak[]; connect: (p: TeamSpeakProperties) => Promise<TeamSpeak>} {
    const connects: FakeTeamSpeak[] = [];

    return {
        connects,
        connect: async () => {
            const fake = {
                id: connects.length + 1,
                forceQuits: 0,
                useBySid: async () => undefined,
                once: () => undefined,
                forceQuit: () => {
                    fake.forceQuits++;
                },
            };
            connects.push(fake);
            return fake as unknown as TeamSpeak;
        },
    };
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

test("повисшая команда отклоняется по таймауту, а не висит вечно", async () => {
    //Сценарий зависания бота: сокет закрылся, библиотека не отклонила команду, промис не разрешится никогда.
    const connector = fakeConnector();
    const connection = new TeamSpeakConnection(properties, silentLogger, 50, "1", connector.connect);

    await assert.rejects(connection.run("clientList", () => never()), TeamSpeakTimeoutError);
});

test("соединение с повисшей командой выбрасывается, следующая операция подключается заново", async () => {
    //В очереди выброшенного соединения застряла команда — всё, что встанет за ней, повисло бы тоже.
    const connector = fakeConnector();
    const connection = new TeamSpeakConnection(properties, silentLogger, 50, "1", connector.connect);

    await assert.rejects(connection.run("clientList", () => never()));
    const result = await connection.run("clientList", async teamSpeak => (teamSpeak as unknown as FakeTeamSpeak).id);

    assert.equal(result, 2, "вторая операция идёт по новому соединению");
    assert.equal(connector.connects[0]?.forceQuits, 1, "старое закрыто принудительно");
});

test("успешные операции делят одно соединение", async () => {
    const connector = fakeConnector();
    const connection = new TeamSpeakConnection(properties, silentLogger, 50, "1", connector.connect);

    await connection.run("a", async () => undefined);
    await connection.run("b", async () => undefined);

    assert.equal(connector.connects.length, 1);
});

test("ошибка команды проходит как есть и соединение не сбрасывает", async () => {
    //Ответ «канал не найден» — это ответ: TeamSpeak жив, соединению можно доверять.
    const connector = fakeConnector();
    const connection = new TeamSpeakConnection(properties, silentLogger, 50, "1", connector.connect);

    await assert.rejects(connection.run("channelEdit", async () => {
        throw new Error("Channel not found");
    }), /Channel not found/);
    await connection.run("clientList", async () => undefined);

    assert.equal(connector.connects.length, 1);
    assert.equal(connector.connects[0]?.forceQuits, 0);
});

test("повисшее подключение тоже упирается в таймаут", async () => {
    const connection = new TeamSpeakConnection(properties, silentLogger, 50, "1", () => never());

    await assert.rejects(connection.run("clientList", async () => undefined), TeamSpeakTimeoutError);
});
