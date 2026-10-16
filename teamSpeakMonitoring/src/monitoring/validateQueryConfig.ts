import {
    SERVER_QUERY_FIELDS,
    unknownQueryFields,
    type A2sQueryConfig,
    type BohemiaQueryConfig,
    type QueryFieldMap,
    type RestQueryConfig,
    type ServerQueryConfig,
} from "./ServerQuery.js";

//Проверка того, что произвольное значение — пригодный ServerQueryConfig. Пригодный — значит
//querier сможет по нему опросить: все поля на месте и нужного вида. Проверяется ровно контракт,
//который querier получает на вход; самих querier'ов это не касается — протоколов здесь нет.
//
//Один источник правды для двух входов: конфиг, приехавший из базы (persistence/parseQueryConfig),
//и конфиг, который вводит администратор в боте. Раньше проверка была только у первого и неполной
//(п. 5 долга в AGENTS.md): {"type":"a2s"} без host и port доезжал до опроса и падал там.
//
//Тексты проблем — по-русски и для человека: их читает администратор в боте и тот, кто смотрит лог.

export type QueryConfigValidation =
    | {ok: true; config: ServerQueryConfig}
    | {ok: false; problems: string[]};

//Потолок таймаута. Не протокольный — здравый смысл: тик опроса ждёт главного источника до его
//таймаута, и минута ожидания уже означает, что интервал опроса сервера растянулся до неё.
export const MAX_QUERY_TIMEOUT_MS = 60_000;

type Fields = Readonly<Record<string, unknown>>;

//Record, а не switch: добавили тип в ServerQueryConfig — сборка падает, пока у него не появится
//проверка. Тот же приём, что QuerierRegistry.
//Каждая проверка собирает конфиг ЗАНОВО из известных полей, а не возвращает пришедший объект:
//лишние ключи (опечатки вроде "prot") в сохранённый конфиг не попадают.
const VALIDATORS: {[T in ServerQueryConfig["type"]]: (raw: Fields, problems: string[]) => Extract<ServerQueryConfig, {type: T}>} = {
    a2s: (raw, problems): A2sQueryConfig => ({
        type: "a2s",
        host: hostOf(raw["host"], "host", problems),
        port: portOf(raw["port"], "port", problems),
        timeout: timeoutOf(raw["timeout"], problems),
    }),
    rest: (raw, problems): RestQueryConfig => ({
        type: "rest",
        url: urlOf(raw["url"], problems),
        timeout: timeoutOf(raw["timeout"], problems),
        fields: fieldMapOf(raw["fields"], problems),
    }),
    bohemia: (raw, problems): BohemiaQueryConfig => ({
        type: "bohemia",
        hostAddress: hostAddressOf(raw["hostAddress"], problems),
        timeout: timeoutOf(raw["timeout"], problems),
    }),
};

export const QUERY_TYPES = Object.keys(VALIDATORS) as ServerQueryConfig["type"][];

export function isQueryType(value: unknown): value is ServerQueryConfig["type"] {
    return typeof value === "string" && (QUERY_TYPES as string[]).includes(value);
}

export function validateQueryConfig(raw: unknown): QueryConfigValidation {
    if (!isRecord(raw)) {
        return {ok: false, problems: ["конфиг должен быть объектом"]};
    }

    const type = raw["type"];

    if (!isQueryType(type)) {
        return {ok: false, problems: [`неизвестный тип «${String(type)}», допустимы: ${QUERY_TYPES.join(", ")}`]};
    }

    const problems: string[] = [];
    const config = VALIDATORS[type](raw, problems);

    return problems.length === 0 ? {ok: true, config} : {ok: false, problems};
}

//Игровой адрес вида host:port — тот же формат у hostAddress источника bohemia и у game_address
//сервера. Экспортирован, потому что адрес сервера проверяет и администрирование серверов.
export function gameAddressProblem(value: unknown, name: string): string | undefined {
    if (typeof value !== "string") {
        return `${name}: нужен адрес вида host:port`;
    }

    const match = /^(\S+):(\d{1,5})$/.exec(value);

    if (!match || !isPort(Number(match[2]))) {
        return `${name}: нужен адрес вида host:port, получено «${value}»`;
    }

    return undefined;
}

function hostOf(value: unknown, name: string, problems: string[]): string {
    if (typeof value !== "string" || value.trim() === "" || /\s/.test(value)) {
        problems.push(`${name}: нужен хост без пробелов`);
        return "";
    }

    return value;
}

function portOf(value: unknown, name: string, problems: string[]): number {
    if (typeof value !== "number" || !isPort(value)) {
        problems.push(`${name}: нужно целое число от 1 до 65535`);
        return 0;
    }

    return value;
}

function timeoutOf(value: unknown, problems: string[]): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_QUERY_TIMEOUT_MS) {
        problems.push(`timeout: нужно целое число миллисекунд от 1 до ${MAX_QUERY_TIMEOUT_MS}`);
        return 0;
    }

    return value;
}

function urlOf(value: unknown, problems: string[]): string {
    if (typeof value !== "string" || !URL.canParse(value)) {
        problems.push("url: нужен адрес вида https://…");
        return "";
    }

    const protocol = new URL(value).protocol;

    if (protocol !== "http:" && protocol !== "https:") {
        problems.push(`url: поддерживаются только http и https, получено «${protocol}»`);
    }

    return value;
}

//Карта полей rest. Пустая — тоже ошибка: источник, который ничего не читает, ничего и не даёт,
//а выглядит настроенным.
function fieldMapOf(value: unknown, problems: string[]): QueryFieldMap {
    if (!isRecord(value)) {
        problems.push(`fields: нужна карта полей, например fields.players=data.online; поля: ${knownFields()}`);
        return {};
    }

    const map = value as QueryFieldMap;
    const unknown = unknownQueryFields(map);

    if (unknown.length > 0) {
        problems.push(`fields: неизвестные поля ${unknown.join(", ")}; допустимы: ${knownFields()}`);
    }

    const entries = Object.entries(map);

    if (entries.length === 0) {
        problems.push(`fields: карта пуста — источник ничего не прочитает; поля: ${knownFields()}`);
    }

    for (const [field, path] of entries) {
        if (typeof path !== "string" || path.trim() === "") {
            problems.push(`fields.${field}: нужен путь в ответе, например data.online`);
        }
    }

    return {...map};
}

function hostAddressOf(value: unknown, problems: string[]): string {
    const problem = gameAddressProblem(value, "hostAddress");

    if (problem) {
        problems.push(problem);
        return "";
    }

    return value as string;
}

function knownFields(): string {
    return Object.keys(SERVER_QUERY_FIELDS).join(", ");
}

function isPort(value: number): boolean {
    return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isRecord(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
