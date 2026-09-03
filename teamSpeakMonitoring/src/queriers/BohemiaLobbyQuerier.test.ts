import test, {mock} from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {BohemiaLobbyQuerier, type BohemiaLobbyProperties} from "./BohemiaLobbyQuerier.js";
import type {BiTokenSource} from "./BiTokenProvider.js";
import type {BohemiaQueryConfig} from "../monitoring/ServerQuery.js";

const silentLogger = {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}} as unknown as Logger;

const properties: BohemiaLobbyProperties = {
    lobbyUrl: "https://lobby.example/rooms/search",
    userAgent: "Arma Reforger/1.8.0.10 (Client; Windows)",
    clientVersion: "1.8.0",
    platformId: "ReforgerSteam",
    gameClientType: "PLATFORM_PC",
};

const HOST = "37.48.253.41:2001";

function config(hostAddress = HOST): BohemiaQueryConfig {
    return {type: "bohemia", hostAddress, timeout: 1000};
}

//Источник токена подменяется константой: HTTP к соседнему сервису — забота BiTokenProvider.
//null, а не undefined, для «токена нет»: явный undefined перекрылся бы значением по умолчанию.
function tokens(token: string | null = "jwt"): BiTokenSource & {invalidated: number} {
    const source = {
        invalidated: 0,
        getToken: async () => token ?? undefined,
        invalidate: () => {
            source.invalidated += 1;
        },
    };

    return source;
}

//Комната в форме реального ответа rooms/search (снято 2026-09-03), лишние поля — тоже,
//чтобы разбор доказанно их игнорировал.
function room(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "34008e3e-9a0c-4be0-b94f-c7f3cb547626",
        scenarioId: "{ECC61978EDCC2B5A}Missions/23_Campaign.conf",
        name: "[RU] #1 | ARMA-RUSSIAN.RU",
        scenarioName: "#AR-Campaign_ScenarioName_Everon",
        gameVersion: "1.8.0.13",
        hostAddress: HOST,
        playerCountLimit: 128,
        playerCount: 128,
        directJoinCode: "0956251811",
        updated: 1788463724,
        runtimeStats: {memory: 1673978, fps: 59},
        joinQueue: {type: "REGULAR", maxSize: 50, size: 7, positionAvgWaitTime: 60},
        mods: [],
        ...overrides,
    };
}

function stubFetch(response: {status?: number; body?: unknown} | Error): {requests: Array<{url: string; init: RequestInit}>} {
    const requests: Array<{url: string; init: RequestInit}> = [];

    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        requests.push({url, init});

        if (response instanceof Error) {
            throw response;
        }

        const status = response.status ?? 200;

        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => response.body,
        } as Response;
    });

    return {requests};
}

test.afterEach(() => {
    mock.restoreAll();
});

test("комната каталога превращается в доменный результат", async () => {
    stubFetch({body: {rooms: [room()], searchFrom: 0, totalCount: 1}});

    const result = await new BohemiaLobbyQuerier(properties, tokens(), silentLogger).query(config());

    assert.deepEqual(result, {
        players: 128,
        maxPlayers: 128,
        queueSize: 7,
        queueMaxSize: 50,
        queueAvgWaitTime: 60,
        scenarioName: "#AR-Campaign_ScenarioName_Everon",
        directJoinCode: "0956251811",
        //Секунды каталога → миллисекунды домена.
        dataUpdatedAt: 1788463724 * 1000,
    });
});

test("запрос уходит POST'ом с токеном в теле и протокольными константами из настроек", async () => {
    const {requests} = stubFetch({body: {rooms: [room()]}});

    await new BohemiaLobbyQuerier(properties, tokens("jwt-42"), silentLogger).query(config());

    const [request] = requests;

    assert.ok(request);
    assert.equal(request.url, properties.lobbyUrl);
    assert.equal(request.init.method, "POST");
    assert.equal((request.init.headers as Record<string, string>)["User-Agent"], properties.userAgent);

    const body = JSON.parse(request.init.body as string) as Record<string, unknown>;

    assert.equal(body["accessToken"], "jwt-42");
    assert.equal(body["hostAddress"], HOST);
    assert.equal(body["clientVersion"], "1.8.0");
    assert.equal(body["platformId"], "ReforgerSteam");
    assert.equal(body["gameClientType"], "PLATFORM_PC");
    //Без ascendent бэкенд отвечает InvalidInput — проверено на живом API.
    assert.equal(body["ascendent"], false);
});

test("без токена запрос не уходит вовсе", async () => {
    const {requests} = stubFetch({body: {rooms: [room()]}});

    const result = await new BohemiaLobbyQuerier(properties, tokens(null), silentLogger).query(config());

    assert.equal(result, undefined);
    assert.equal(requests.length, 0);
});

test("401 и 403 сбрасывают токен и считаются неудачей опроса", async () => {
    for (const status of [401, 403]) {
        stubFetch({status});
        const source = tokens();

        const result = await new BohemiaLobbyQuerier(properties, source, silentLogger).query(config());

        assert.equal(result, undefined, `HTTP ${status}`);
        assert.equal(source.invalidated, 1, `HTTP ${status} должен сбросить кэш токена`);
        mock.restoreAll();
    }
});

test("остальные ошибки HTTP токен не трогают", async () => {
    stubFetch({status: 500});
    const source = tokens();

    assert.equal(await new BohemiaLobbyQuerier(properties, source, silentLogger).query(config()), undefined);
    assert.equal(source.invalidated, 0);
});

test("сетевая ошибка — неудача опроса, а не исключение", async () => {
    stubFetch(new Error("socket hang up"));

    assert.equal(await new BohemiaLobbyQuerier(properties, tokens(), silentLogger).query(config()), undefined);
});

test("сервера нет в каталоге — неудача опроса, а не пустой результат", async () => {
    //Бэкенд может вернуть чужие комнаты или ничего: и то и другое — «каталог сервер не знает».
    stubFetch({body: {rooms: [room({hostAddress: "1.2.3.4:2001"})]}});

    assert.equal(await new BohemiaLobbyQuerier(properties, tokens(), silentLogger).query(config()), undefined);
});

test("из нескольких комнат берётся та, что совпала по адресу", async () => {
    stubFetch({body: {rooms: [room({hostAddress: "1.2.3.4:2001", playerCount: 1}), room({playerCount: 77})]}});

    const result = await new BohemiaLobbyQuerier(properties, tokens(), silentLogger).query(config());

    assert.equal(result?.players, 77);
});

test("без joinQueue очередь отсутствует, остальное на месте", async () => {
    //joinQueue в ответе необязателен — у части серверов его нет вовсе.
    stubFetch({body: {rooms: [room({joinQueue: undefined})]}});

    const result = await new BohemiaLobbyQuerier(properties, tokens(), silentLogger).query(config());

    assert.equal(result?.queueSize, undefined);
    assert.equal(result?.queueMaxSize, undefined);
    assert.equal(result?.players, 128);
});

test("поле неверного типа пропускается, а не приводится", async () => {
    stubFetch({body: {rooms: [room({playerCount: "128", updated: "вчера", directJoinCode: ""})]}});

    const result = await new BohemiaLobbyQuerier(properties, tokens(), silentLogger).query(config());

    assert.equal(result?.players, undefined);
    assert.equal(result?.dataUpdatedAt, undefined);
    assert.equal(result?.directJoinCode, undefined);
    assert.equal(result?.maxPlayers, 128);
});

test("ответ без массива rooms — неудача опроса", async () => {
    stubFetch({body: {error: "InvalidInput"}});

    assert.equal(await new BohemiaLobbyQuerier(properties, tokens(), silentLogger).query(config()), undefined);
});

test("чужой конфиг — ошибка проводки, а не тихий undefined", async () => {
    stubFetch({body: {rooms: []}});

    await assert.rejects(
        () => new BohemiaLobbyQuerier(properties, tokens(), silentLogger)
            .query({type: "a2s", host: "127.0.0.1", port: 17777, timeout: 1000}),
        /Querier for "bohemia" received a "a2s" query config/,
    );
});
