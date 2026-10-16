import test from "node:test";
import assert from "node:assert/strict";
import {gameAddressProblem, validateQueryConfig, type QueryConfigValidation} from "./validateQueryConfig.js";

function problemsOf(validation: QueryConfigValidation): string[] {
    return validation.ok ? [] : validation.problems;
}

test("пригодный a2s проходит", () => {
    assert.deepEqual(
        validateQueryConfig({type: "a2s", host: "37.48.253.41", port: 17771, timeout: 5000}),
        {ok: true, config: {type: "a2s", host: "37.48.253.41", port: 17771, timeout: 5000}},
    );
});

test("пригодный rest проходит с частичной картой", () => {
    const validation = validateQueryConfig({
        type: "rest",
        url: "https://e.com/api?x=1",
        timeout: 5000,
        fields: {players: "data.online"},
    });

    assert.equal(validation.ok, true);
});

test("пригодный bohemia проходит", () => {
    assert.equal(validateQueryConfig({type: "bohemia", hostAddress: "37.48.253.41:2001", timeout: 5000}).ok, true);
});

test("все проблемы перечисляются сразу, а не по одной", () => {
    //Администратор в боте исправляет ввод за один заход, а не узнаёт о проблемах по очереди.
    const problems = problemsOf(validateQueryConfig({type: "a2s"}));

    assert.equal(problems.length, 3);
    assert.match(problems.join("\n"), /host/);
    assert.match(problems.join("\n"), /port/);
    assert.match(problems.join("\n"), /timeout/);
});

test("порт вне диапазона и не число — ошибка", () => {
    for (const port of [0, 65_536, 1.5, "17771"]) {
        assert.match(
            problemsOf(validateQueryConfig({type: "a2s", host: "h", port, timeout: 5000})).join(),
            /port/,
            `порт ${String(port)}`,
        );
    }
});

test("таймаут больше минуты — ошибка", () => {
    assert.match(
        problemsOf(validateQueryConfig({type: "a2s", host: "h", port: 1, timeout: 120_000})).join(),
        /timeout/,
    );
});

test("хост с пробелом — ошибка", () => {
    assert.match(problemsOf(validateQueryConfig({type: "a2s", host: "a b", port: 1, timeout: 1})).join(), /host/);
});

test("rest: не http(s), пустая карта и неизвестные поля — ошибки", () => {
    assert.match(
        problemsOf(validateQueryConfig({type: "rest", url: "ftp://e.com", timeout: 1, fields: {players: "a"}})).join(),
        /http и https/,
    );
    assert.match(
        problemsOf(validateQueryConfig({type: "rest", url: "https://e.com", timeout: 1, fields: {}})).join(),
        /карта пуста/,
    );
    assert.match(
        problemsOf(validateQueryConfig({type: "rest", url: "https://e.com", timeout: 1, fields: {playrs: "a"}})).join(),
        /неизвестные поля playrs/,
    );
    assert.match(
        problemsOf(validateQueryConfig({type: "rest", url: "https://e.com", timeout: 1, fields: {players: ""}})).join(),
        /fields\.players/,
    );
});

test("неизвестный тип и не-объект — понятная ошибка", () => {
    assert.match(problemsOf(validateQueryConfig({type: "ping"})).join(), /неизвестный тип «ping»/);
    assert.match(problemsOf(validateQueryConfig("a2s")).join(), /объектом/);
    assert.match(problemsOf(validateQueryConfig([])).join(), /объектом/);
});

test("лишние ключи в собранный конфиг не попадают", () => {
    const validation = validateQueryConfig({type: "bohemia", hostAddress: "1.2.3.4:2001", timeout: 1, extra: true});

    assert.deepEqual(validation, {ok: true, config: {type: "bohemia", hostAddress: "1.2.3.4:2001", timeout: 1}});
});

test("игровой адрес: host:port, порт в диапазоне", () => {
    assert.equal(gameAddressProblem("37.48.253.41:2001", "address"), undefined);
    assert.equal(gameAddressProblem("[::1]:2001", "address"), undefined);
    assert.ok(gameAddressProblem("37.48.253.41", "address"));
    assert.ok(gameAddressProblem("host:99999", "address"));
    assert.ok(gameAddressProblem("a b:2001", "address"));
    assert.ok(gameAddressProblem(":2001", "address"));
});
