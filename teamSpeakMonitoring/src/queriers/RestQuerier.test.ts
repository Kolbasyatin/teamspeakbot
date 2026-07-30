import test, {mock} from "node:test";
import assert from "node:assert/strict";
import {RestQuerier} from "./RestQuerier.js";
import type {RestQueryConfig} from "../monitoring/ServerQuery.js";

const restConfig: RestQueryConfig = {
    type: "rest",
    url: "https://example.com/status",
    timeout: 1000,
};

//Подменяем глобальный fetch: сам HTTP тут не проверяется, проверяется разбор ответа.
function stubFetch(response: {ok?: boolean; status?: number; body?: unknown} | Error): void {
    mock.method(globalThis, "fetch", async () => {
        if (response instanceof Error) {
            throw response;
        }

        return {
            ok: response.ok ?? true,
            status: response.status ?? 200,
            json: async () => response.body,
        } as Response;
    });
}

test.afterEach(() => {
    mock.restoreAll();
});

test("корректный ответ превращается в доменный результат", async () => {
    stubFetch({body: {players: 42, maxPlayers: 128}});

    const result = await new RestQuerier().query(restConfig);

    assert.deepEqual(result, {players: 42, maxPlayers: 128});
});

test("лишние поля ответа в домен не попадают", async () => {
    //До итерации 3 здесь стоял каст as ServerInfo, и в домен уезжало всё, что пришло.
    stubFetch({body: {players: 1, maxPlayers: 2, name: "Server", queue: 5, junk: {a: 1}}});

    const result = await new RestQuerier().query(restConfig);

    assert.deepEqual(result, {players: 1, maxPlayers: 2});
});

test("ответ без players приравнивается к неудачному опросу", async () => {
    //Раньше каст пропускал это молча, и сервер вечно рендерился как unknown.
    stubFetch({body: {maxPlayers: 64}});

    assert.equal(await new RestQuerier().query(restConfig), undefined);
});

test("players строкой считается непригодным ответом", async () => {
    stubFetch({body: {players: "42", maxPlayers: 128}});

    assert.equal(await new RestQuerier().query(restConfig), undefined);
});

test("не-объект в теле ответа приравнивается к неудачному опросу", async () => {
    stubFetch({body: "внезапно строка"});

    assert.equal(await new RestQuerier().query(restConfig), undefined);
});

test("HTTP-ошибка приравнивается к неудачному опросу", async () => {
    stubFetch({ok: false, status: 503, body: {players: 1, maxPlayers: 2}});

    assert.equal(await new RestQuerier().query(restConfig), undefined);
});

test("отказ сети приравнивается к неудачному опросу", async () => {
    stubFetch(new Error("ECONNREFUSED"));

    assert.equal(await new RestQuerier().query(restConfig), undefined);
});
