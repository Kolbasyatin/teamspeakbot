import test from "node:test";
import assert from "node:assert/strict";
import {narrowQueryConfig, SERVER_QUERY_FIELDS, unknownQueryFields} from "./ServerQuery.js";

test("сужение пропускает конфиг своего типа как есть", () => {
    const config = {type: "bohemia", hostAddress: "1.2.3.4:2001", timeout: 5000} as const;

    assert.equal(narrowQueryConfig(config, "bohemia"), config);
});

test("чужой конфиг — понятная ошибка с обоими типами", () => {
    //Раньше здесь был `config as A2sQueryConfig`: чужой конфиг падал бы внутри библиотеки
    //протокола с текстом, по которому ошибку проводки не найти.
    assert.throws(
        () => narrowQueryConfig({type: "rest", url: "https://e.com", timeout: 1, fields: {}}, "a2s"),
        /Querier for "a2s" received a "rest" query config/,
    );
});

test("словарь полей знает тип каждого поля", () => {
    //Карта из БД проверяется по именам, чужой JSON — по типам; оба берутся отсюда.
    assert.equal(SERVER_QUERY_FIELDS.queueSize, "number");
    assert.equal(SERVER_QUERY_FIELDS.scenarioName, "string");
    assert.deepEqual(unknownQueryFields({queueSize: "q.size", scenarioName: "scenario"}), []);
});
