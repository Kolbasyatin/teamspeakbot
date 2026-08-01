import test from "node:test";
import assert from "node:assert/strict";
import {resolvePrimarySource} from "./resolvePrimarySource.js";
import type {ServerQueryRole, ServerQuerySource} from "./MonitoredServer.js";

function source(id: number, role: ServerQueryRole, priority: number): ServerQuerySource {
    return {
        id,
        role,
        priority,
        query: {type: "a2s", host: "127.0.0.1", port: 17770 + id, timeout: 1000},
    };
}

test("явно назначенный primary выигрывает у более приоритетного помощника", () => {
    //Ровно та комбинация, ради которой role и priority — разные колонки: статус берём
    //у надёжного источника, данные — у того, что стоит выше по приоритету.
    const chosen = resolvePrimarySource([source(1, "secondary", 0), source(2, "primary", 10)], 42);

    assert.equal(chosen?.id, 2);
});

test("без primary главным становится самый приоритетный", () => {
    //Так выглядит отключённый главный источник: его просто нет в списке включённых.
    const chosen = resolvePrimarySource([source(1, "secondary", 0), source(2, "secondary", 10)], 42);

    assert.equal(chosen?.id, 1);
});

test("единственный источник главный, даже если помечен помощником", () => {
    const chosen = resolvePrimarySource([source(7, "secondary", 99)], 42);

    assert.equal(chosen?.id, 7);
});

test("пустой список источников — не ошибка, а отсутствие главного", () => {
    //Сервер, у которого все источники отключены. Ошибкой это не считаем: вызывающий
    //пропустит такой сервер, а не уронит чтение остальных.
    assert.equal(resolvePrimarySource([], 42), undefined);
});

test("два включённых primary — ошибка с номером сервера", () => {
    //Выбирать «какого-нибудь» нельзя: поведение стало бы зависеть от порядка строк в выдаче БД.
    assert.throws(
        () => resolvePrimarySource([source(1, "primary", 0), source(2, "primary", 1)], 42),
        /Server 42 has 2 enabled primary query sources/,
    );
});
