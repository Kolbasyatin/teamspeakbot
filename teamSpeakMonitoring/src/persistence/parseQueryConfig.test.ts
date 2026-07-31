import test from "node:test";
import assert from "node:assert/strict";
import {parseQueryConfig, type QueryConfigRow} from "./parseQueryConfig.js";

function row(overrides: Partial<QueryConfigRow>): QueryConfigRow {
    return {
        id: 1,
        queryType: "a2s",
        queryConfig: '{"type":"a2s","host":"127.0.0.1","port":27015,"timeout":5000}',
        ...overrides,
    };
}

test("строка JSON разбирается в конфиг опроса", () => {
    const config = parseQueryConfig(row({}));

    assert.deepEqual(config, {type: "a2s", host: "127.0.0.1", port: 27015, timeout: 5_000});
});

test("уже разобранный объект проходит как есть", () => {
    //Драйвер может отдать колонку longtext + json_valid либо строкой, либо объектом,
    //поэтому обе ветки нужны и обе покрыты.
    const config = parseQueryConfig(row({
        queryType: "rest",
        queryConfig: {type: "rest", url: "https://example.com/status", timeout: 5_000},
    }));

    assert.deepEqual(config, {type: "rest", url: "https://example.com/status", timeout: 5_000});
});

test("расхождение query_type с полем type — ошибка с номером сервера", () => {
    assert.throws(
        () => parseQueryConfig(row({id: 42, queryType: "rest"})),
        /query_type mismatch for server 42/,
    );
});

test("отсутствие type внутри конфига — то же расхождение", () => {
    assert.throws(
        () => parseQueryConfig(row({queryConfig: '{"host":"127.0.0.1"}'})),
        /query_type mismatch/,
    );
});

test("null в query_config — ошибка про непригодный конфиг", () => {
    assert.throws(() => parseQueryConfig(row({queryConfig: "null"})), /Invalid query_config for server 1/);
});

test("не-объект в query_config — та же ошибка", () => {
    assert.throws(() => parseQueryConfig(row({queryConfig: "5"})), /Invalid query_config for server 1/);
});

test("невалидный JSON пробрасывается как SyntaxError, а не как ошибка про сервер", () => {
    //Характеризационный тест: сейчас JSON.parse не обёрнут, поэтому в лог уйдёт SyntaxError
    //без номера сервера. Поведение зафиксировано как есть; менять — отдельным шагом.
    assert.throws(() => parseQueryConfig(row({queryConfig: "{не json"})), SyntaxError);
});

test("поля внутри конфига не проверяются: {type} без host и port проходит", () => {
    //Фиксирует дефект п. 5 долга: на входе есть только сверка type, формы конфига никто не проверяет.
    //Такой сервер доедет до querier'а и упадёт уже там, в опросе.
    const config = parseQueryConfig(row({queryConfig: '{"type":"a2s"}'}));

    assert.deepEqual(config, {type: "a2s"} as unknown as typeof config);
});
