import {
    unknownQueryFields,
    type RestQueryConfig,
    type ServerQueryConfig,
} from "../monitoring/ServerQuery.js";

//То, что нужно для разбора конфига опроса, и ничего больше: строка целиком тут не требуется.
//queryConfig приезжает либо строкой JSON, либо уже разобранным объектом — зависит от того,
//как драйвер обошёлся с колонкой longtext + json_valid.
//id и serverId нужны только для текста ошибки: по id чинят строку, по serverId её находят
//среди источников одного сервера. Оба BigInt: колонки bigint, драйвер mariadb отдаёт их именно так.
export interface QueryConfigRow {
    id: number | bigint;
    serverId: number | bigint;
    queryType: ServerQueryConfig["type"];
    queryConfig: string | ServerQueryConfig;
}

//Единственное место с настоящей логикой в persistence: разбор JSON, ветка «строка или объект»
//и сверка query_type с полем type внутри конфига. Чистая функция, потому что БД для этого не нужна —
//нужны строки-фикстуры. До выделения весь этот разбор проверялся только интеграционным тестом,
//который требует живую MariaDB.
export function parseQueryConfig(row: QueryConfigRow): ServerQueryConfig {
    const queryConfig: unknown = typeof row.queryConfig === "string"
        ? JSON.parse(row.queryConfig)
        : row.queryConfig;

    if (!queryConfig || typeof queryConfig !== "object") {
        throw new Error(`Invalid query_config for query source ${row.id} (server ${row.serverId})`);
    }

    const query = queryConfig as Partial<ServerQueryConfig>;

    //Две колонки описывают одно и то же, поэтому их расхождение — это порча данных, а не вариант нормы.
    if (query.type !== row.queryType) {
        throw new Error(`query_type mismatch for query source ${row.id} (server ${row.serverId})`);
    }

    if (query.type === "rest") {
        assertUsableFieldMap(query as Partial<RestQueryConfig>, row);
    }

    return query as ServerQueryConfig;
}

//Карта полей — единственное место в конфиге, которое проверяется по существу, и вот почему.
//Опечатка в её ключе не проявляется ничем: источник настроен, эндпоинт отвечает, поле просто
//никогда не читается. Тип тут не помощник — карта приезжает из БД строкой, компилятор её не видел.
//Остальные поля конфига при поломке падают в самом опросе и видны по логу querier'а.
function assertUsableFieldMap(query: Partial<RestQueryConfig>, row: QueryConfigRow): void {
    const where = `query source ${row.id} (server ${row.serverId})`;

    if (!query.fields || typeof query.fields !== "object") {
        throw new Error(`Missing fields map in rest query_config for ${where}`);
    }

    const unknown = unknownQueryFields(query.fields);

    if (unknown.length > 0) {
        throw new Error(`Unknown query fields [${unknown.join(", ")}] in ${where}`);
    }
}
