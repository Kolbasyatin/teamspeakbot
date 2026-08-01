import test from "node:test";
import assert from "node:assert/strict";
import {buildMonitorConfigs} from "./buildMonitorConfigs.js";
import type {ServerQueryRole, ServerQuerySource, StoredServer} from "./MonitoredServer.js";

//Эти правила до выделения проверялись только интеграционным тестом по живой MariaDB, хотя
//к SQL отношения не имеют. Тот же мотив, по которому из репозитория вынимали parseQueryConfig.

function source(id: number, role: ServerQueryRole, priority: number): ServerQuerySource {
    return {
        id,
        role,
        priority,
        query: {type: "a2s", host: "127.0.0.1", port: 17770 + id, timeout: 1000},
    };
}

function storedServer(sources: ServerQuerySource[], id: number = 1): StoredServer {
    return {id, name: `Server ${id}`, gameAddress: "127.0.0.1:2001", sources};
}

test("источники упорядочиваются по приоритету", () => {
    //Порядок задаёт домен, а не ORDER BY: иначе забытая сортировка в новой реализации хранилища
    //молча меняла бы то, чьи данные побеждают при слиянии.
    const {configs} = buildMonitorConfigs([
        storedServer([source(1, "secondary", 5), source(2, "primary", 1)]),
    ]);

    assert.deepEqual(configs[0]?.sources.map(item => item.id), [2, 1]);
});

test("при равном приоритете порядок задаёт id", () => {
    //Без добивания ничьей порядок зависел бы от выдачи хранилища и различался бы между реализациями.
    const {configs} = buildMonitorConfigs([
        storedServer([source(9, "secondary", 0), source(3, "secondary", 0)]),
    ]);

    assert.deepEqual(configs[0]?.sources.map(item => item.id), [3, 9]);
});

test("входной массив источников не мутируется", () => {
    const sources = [source(9, "secondary", 5), source(3, "primary", 1)];
    buildMonitorConfigs([storedServer(sources)]);

    assert.deepEqual(sources.map(item => item.id), [9, 3], "порядок у вызывающего прежний");
});

test("primarySource — ссылка на элемент sources, а не копия", () => {
    const {configs} = buildMonitorConfigs([
        storedServer([source(1, "secondary", 0), source(2, "primary", 10)]),
    ]);
    const config = configs[0];

    assert.ok(config?.sources.includes(config.primarySource));
    assert.equal(config?.primarySource.id, 2, "роль важнее приоритета при выборе главного");
});

test("без включённого primary главным становится приоритетный, и это не проходит молча", () => {
    const {configs, notices} = buildMonitorConfigs([
        storedServer([source(1, "secondary", 7), source(2, "secondary", 3)]),
    ]);

    assert.equal(configs[0]?.primarySource.id, 2);
    assert.deepEqual(notices, [
        {type: "primaryFallback", serverId: 1, serverName: "Server 1", sourceId: 2},
    ]);
});

test("сервер без источников не попадает в конфиги и даёт предупреждение", () => {
    const {configs, notices} = buildMonitorConfigs([storedServer([])]);

    assert.deepEqual(configs, []);
    assert.deepEqual(notices, [
        {type: "noEnabledSources", serverId: 1, serverName: "Server 1"},
    ]);
});

test("выброшенный сервер не мешает собрать остальные", () => {
    //Обе ситуации рабочие, поэтому они данные, а не исключения: один сервер без источников
    //не должен обрушивать чтение всего списка.
    const {configs, notices} = buildMonitorConfigs([
        storedServer([], 1),
        storedServer([source(5, "primary", 0)], 2),
    ]);

    assert.deepEqual(configs.map(config => config.id), [2]);
    assert.equal(notices.length, 1);
});

test("нормальный сервер собирается без предупреждений", () => {
    const {configs, notices} = buildMonitorConfigs([
        storedServer([source(1, "primary", 0), source(2, "secondary", 1)]),
    ]);

    assert.equal(configs.length, 1);
    assert.deepEqual(notices, []);
});

test("пустой список серверов — пустой результат", () => {
    assert.deepEqual(buildMonitorConfigs([]), {configs: [], notices: []});
});

test("два включённых primary роняют сборку", () => {
    //Порча данных, а не вариант нормы: выбор наугад сделал бы статус сервера зависящим
    //от порядка строк в выдаче хранилища.
    assert.throws(
        () => buildMonitorConfigs([storedServer([source(1, "primary", 0), source(2, "primary", 1)])]),
        /Server 1 has 2 enabled primary query sources/,
    );
});
