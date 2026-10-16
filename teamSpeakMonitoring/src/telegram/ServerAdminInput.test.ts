import test from "node:test";
import assert from "node:assert/strict";
import {parseArguments, parseId, parseNewServer} from "./ServerAdminInput.js";

test("значение тянется до следующего ключа — пробелы без кавычек", () => {
    //Имена серверов почти всегда с пробелами, а кавычки с телефона набирать неудобно.
    assert.deepEqual(parseArguments("12 name=#1 ARMA RUSSIAN address=37.48.253.41:2001"), {
        positional: ["12"],
        params: {name: "#1 ARMA RUSSIAN", address: "37.48.253.41:2001"},
        problems: [],
    });
});

test("знак равенства внутри url ключом не считается", () => {
    assert.deepEqual(parseArguments("14 rest url=https://e.com/api?x=1&y=2 fields.players=data.online").params, {
        url: "https://e.com/api?x=1&y=2",
        "fields.players": "data.online",
    });
});

test("позиционные аргументы — всё до первого ключа", () => {
    assert.deepEqual(parseArguments("14 a2s port=17771").positional, ["14", "a2s"]);
    assert.deepEqual(parseArguments("  14  ").positional, ["14"]);
    assert.deepEqual(parseArguments("").positional, []);
});

test("пустое значение допустимо: так убирается поле карты", () => {
    assert.deepEqual(parseArguments("34 fields.maxPlayers=").params, {"fields.maxPlayers": ""});
});

test("повтор ключа — проблема, а не молчаливая перезапись", () => {
    assert.deepEqual(parseArguments("34 port=1 port=2").problems, ["параметр port указан дважды"]);
});

test("новый сервер: имя с пробелами и адрес через черту", () => {
    assert.deepEqual(parseNewServer("#1 ARMA RUSSIAN | 37.48.253.41:2001"), {
        name: "#1 ARMA RUSSIAN",
        address: "37.48.253.41:2001",
    });
    assert.deepEqual(parseNewServer("name=Test address=1.2.3.4:2001"), {name: "Test", address: "1.2.3.4:2001"});
    assert.equal(parseNewServer("просто имя"), undefined);
});

test("id — только положительное целое", () => {
    assert.equal(parseId("14"), 14);
    assert.equal(parseId("0"), undefined);
    assert.equal(parseId("-3"), undefined);
    assert.equal(parseId("14a"), undefined);
    assert.equal(parseId(undefined), undefined);
});
