import test, {mock} from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {RestQuerier} from "./RestQuerier.js";
import type {QueryFieldMap, RestQueryConfig} from "../monitoring/ServerQuery.js";

const silentLogger = {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}} as unknown as Logger;

//Карта «имена в ответе совпадают с доменными». Раньше это предположение было зашито в код —
//теперь это всего лишь один из возможных конфигов, и тесты ниже проверяют другие тоже.
const identityFields: QueryFieldMap = {players: "players", maxPlayers: "maxPlayers"};

function restConfig(fields: QueryFieldMap = identityFields): RestQueryConfig {
    return {
        type: "rest",
        url: "https://example.com/status",
        timeout: 1000,
        fields,
    };
}

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

function query(fields?: QueryFieldMap): Promise<unknown> {
    return new RestQuerier(silentLogger).query(restConfig(fields));
}

test.afterEach(() => {
    mock.restoreAll();
});

test("корректный ответ превращается в доменный результат", async () => {
    stubFetch({body: {players: 42, maxPlayers: 128}});

    assert.deepEqual(await query(), {players: 42, maxPlayers: 128});
});

test("имена полей берутся из карты, а не угадываются", async () => {
    //Ради этого карта и вводилась: чужой эндпоинт не обязан называть поля так, как их зовут в домене.
    stubFetch({body: {hohohoFieldPlayers: 12, maxSlots: 64}});

    assert.deepEqual(
        await query({players: "hohohoFieldPlayers", maxPlayers: "maxSlots"}),
        {players: 12, maxPlayers: 64},
    );
});

test("путь с точкой достаёт вложенное поле", async () => {
    //Без вложенности карта не выполняла бы задачи: первый же реальный API потребовал бы правки кода.
    stubFetch({body: {data: {online: 7, capacity: 32}}});

    assert.deepEqual(
        await query({players: "data.online", maxPlayers: "data.capacity"}),
        {players: 7, maxPlayers: 32},
    );
});

test("оборванный путь равнозначен отсутствию поля", async () => {
    stubFetch({body: {data: {online: 7}}});

    assert.deepEqual(
        await query({players: "data.online", maxPlayers: "nested.deeply.missing"}),
        {players: 7},
    );
});

test("путь, упирающийся в не-объект, не роняет разбор", async () => {
    stubFetch({body: {players: 7, data: "строка вместо объекта"}});

    assert.deepEqual(await query({players: "players", maxPlayers: "data.capacity"}), {players: 7});
});

test("лишние поля ответа в домен не попадают", async () => {
    //Чего нет в карте, того не существует: карта отвечает «где взять players»,
    //а не «куда девать это непонятное поле».
    stubFetch({body: {players: 1, maxPlayers: 2, name: "Server", queue: 5, junk: {a: 1}}});

    assert.deepEqual(await query(), {players: 1, maxPlayers: 2});
});

test("ответ без players отдаёт то, что в нём есть", async () => {
    //Поведение изменено вместе с появлением нескольких источников. Раньше отсутствие players
    //означало неудачный опрос целиком: для единственного источника это было верно, для
    //второстепенного — вредно, он выбрасывал бы собственные валидные данные.
    stubFetch({body: {maxPlayers: 64}});

    assert.deepEqual(await query(), {maxPlayers: 64});
});

test("непригодное поле пропускается, годное остаётся", async () => {
    //players строкой — это сломанное поле, а не сломанный ответ. К числу молча не приводим:
    //приведение спрятало бы поломку эндпоинта.
    stubFetch({body: {players: "42", maxPlayers: 128}});

    assert.deepEqual(await query(), {maxPlayers: 128});
});

test("null, NaN и Infinity полями не считаются", async () => {
    stubFetch({body: {players: null, maxPlayers: 64}});

    assert.deepEqual(await query(), {maxPlayers: 64});
});

test("объект без единого пригодного поля — неудачный опрос", async () => {
    //Так выглядит {"error":"server not found"} с кодом 200. Отличить его от поломанного
    //эндпоинта нечем, поэтому сервер живым не считаем.
    stubFetch({body: {error: "server not found"}});

    assert.equal(await query(), undefined);
});

test("пустая карта означает, что читать нечего", async () => {
    stubFetch({body: {players: 42, maxPlayers: 128}});

    assert.equal(await query({}), undefined);
});

test("не-объект в теле ответа приравнивается к неудачному опросу", async () => {
    stubFetch({body: "внезапно строка"});

    assert.equal(await query(), undefined);
});

test("HTTP-ошибка приравнивается к неудачному опросу", async () => {
    stubFetch({ok: false, status: 503, body: {players: 1, maxPlayers: 2}});

    assert.equal(await query(), undefined);
});

test("отказ сети приравнивается к неудачному опросу", async () => {
    stubFetch(new Error("ECONNREFUSED"));

    assert.equal(await query(), undefined);
});

test("строковое поле читается строкой, а числовое — числом; перепутанные типы пропускаются", async () => {
    //Тип каждого поля задаёт словарь домена, карта задаёт только имена: "12" в players — сломанный
    //эндпоинт, 5 в scenarioName — тоже, и оба молча не чинятся.
    stubFetch({body: {scenario: "Командующий - Колгуев", players: "12", queue: {size: 4}, code: 5}});

    assert.deepEqual(
        await query({scenarioName: "scenario", players: "players", queueSize: "queue.size", directJoinCode: "code"}),
        {scenarioName: "Командующий - Колгуев", queueSize: 4},
    );
});

test("пустая строка равнозначна отсутствию поля", async () => {
    stubFetch({body: {scenario: "", players: 3}});

    assert.deepEqual(await query({scenarioName: "scenario", players: "players"}), {players: 3});
});

test("чужой конфиг — ошибка проводки, а не тихий undefined", async () => {
    await assert.rejects(
        () => new RestQuerier(silentLogger).query({type: "a2s", host: "127.0.0.1", port: 1, timeout: 1}),
        /Querier for "rest" received a "a2s" query config/,
    );
});
