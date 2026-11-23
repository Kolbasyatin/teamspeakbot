import test from "node:test";
import assert from "node:assert/strict";
import {describeTarget, listNameProblem, parseTarget, targetFromDescription} from "./Broadcasts.js";

test("адресат: chat_id, встроенные all и unsorted, иначе имя списка", () => {
    assert.deepEqual(parseTarget("555"), {kind: "chat", chatId: 555});
    assert.deepEqual(parseTarget("-1003738458034"), {kind: "chat", chatId: -1003738458034});
    assert.deepEqual(parseTarget("ALL"), {kind: "all"});
    assert.deepEqual(parseTarget("unsorted"), {kind: "unsorted"});
    assert.deepEqual(parseTarget("Klan"), {kind: "list", name: "klan"});
    assert.equal(parseTarget(""), undefined);
    assert.equal(parseTarget("клан"), undefined, "кириллица — не имя списка");
});

test("имя списка: латиница, цифры и «_», с буквы; all и unsorted заняты", () => {
    assert.equal(listNameProblem("klan"), undefined);
    assert.equal(listNameProblem("testers_2"), undefined);
    assert.equal(listNameProblem("all"), "reserved");
    assert.equal(listNameProblem("unsorted"), "reserved");
    assert.equal(listNameProblem("2klan"), "format", "с цифры — неотличимо от chat_id");
    assert.equal(listNameProblem("k"), "format");
    assert.equal(listNameProblem("Klan"), "format");
});

test("адресат сохраняется в журнал и читается обратно тем же", () => {
    for (const raw of ["555", "-100", "all", "unsorted", "klan"]) {
        const target = parseTarget(raw);
        assert.ok(target);
        assert.deepEqual(targetFromDescription(describeTarget(target)), target);
    }

    assert.equal(describeTarget({kind: "list", name: "klan"}), "list:klan");
});
