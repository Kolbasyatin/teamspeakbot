import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";
import {DEFAULT_SOURCE_TIMEOUT_MS} from "./ServerAdminModel.js";

//Как администратор задаёт конфиг источника: плоские параметры «ключ=значение» → сырой объект,
//который потом проверяет validateQueryConfig. Формат ввода не телеграмный: те же параметры пришли бы
//и из HTTP-формы, поэтому живёт он здесь, а не в адаптере.
//
//Здесь нет проверки — только перевод строк в значения нужного вида. Проверка одна, в validateQueryConfig,
//и запускается после: так текст ошибки про порт одинаков, откуда бы конфиг ни пришёл.

type ParamKind = "string" | "number";

interface SourceForm {
    //Параметры типа и во что их переводить. Порядок — порядок в подсказке.
    params: Readonly<Record<string, ParamKind>>;
    //Есть ли у типа карта полей (fields.<поле>=<путь>).
    fieldMap: boolean;
    //Что подставить, если параметр не назван. gameAddress — игровой адрес сервера.
    defaults: (gameAddress: string) => Record<string, unknown>;
}

//Record по типу: новый тип источника без формы не скомпилируется, как и без проверки.
const SOURCE_FORMS: Record<ServerQueryConfig["type"], SourceForm> = {
    a2s: {
        params: {host: "string", port: "number", timeout: "number"},
        fieldMap: false,
        //A2S почти всегда на том же хосте, что и игра, — отличается только порт.
        defaults: gameAddress => ({host: hostOf(gameAddress), timeout: DEFAULT_SOURCE_TIMEOUT_MS}),
    },
    rest: {
        params: {url: "string", timeout: "number"},
        fieldMap: true,
        defaults: () => ({timeout: DEFAULT_SOURCE_TIMEOUT_MS}),
    },
    bohemia: {
        params: {hostAddress: "string", timeout: "number"},
        fieldMap: false,
        //Каталог Bohemia ищет сервер ровно по игровому адресу.
        defaults: gameAddress => ({hostAddress: gameAddress, timeout: DEFAULT_SOURCE_TIMEOUT_MS}),
    },
};

//Подсказка администратору: какие параметры есть у типа.
export function describeSourceForm(type: ServerQueryConfig["type"]): string {
    const form = SOURCE_FORMS[type];
    const params = Object.keys(form.params);

    return [...params, ...(form.fieldMap ? ["fields.<поле>"] : [])].join(", ");
}

export interface RawConfigBuild {
    raw: Record<string, unknown>;
    problems: string[];
}

//Новый конфиг: умолчания типа, поверх них — то, что назвал администратор.
export function buildNewConfig(
    type: ServerQueryConfig["type"],
    params: Readonly<Record<string, string>>,
    gameAddress: string,
): RawConfigBuild {
    return applyParams(type, {...SOURCE_FORMS[type].defaults(gameAddress), type}, params);
}

//Правка: существующий конфиг, поверх него — изменённые параметры. Пустое значение у поля карты
//(fields.players=) убирает поле из карты.
export function applyParams(
    type: ServerQueryConfig["type"],
    base: Readonly<Record<string, unknown>>,
    params: Readonly<Record<string, string>>,
): RawConfigBuild {
    const form = SOURCE_FORMS[type];
    const raw: Record<string, unknown> = {...base, type};
    const fields: Record<string, unknown> = isRecord(base["fields"]) ? {...base["fields"]} : {};
    const problems: string[] = [];
    let fieldsTouched = false;

    for (const [key, value] of Object.entries(params)) {
        const kind = form.params[key];

        if (kind !== undefined) {
            raw[key] = kind === "number" && /^-?\d+$/.test(value) ? Number(value) : value;
            continue;
        }

        if (form.fieldMap && key.startsWith("fields.") && key.length > "fields.".length) {
            const field = key.slice("fields.".length);

            if (value === "") {
                delete fields[field];
            } else {
                fields[field] = value;
            }

            fieldsTouched = true;
            continue;
        }

        problems.push(`неизвестный параметр «${key}» для ${type}; есть: ${describeSourceForm(type)}`);
    }

    if (form.fieldMap && (fieldsTouched || isRecord(base["fields"]))) {
        raw["fields"] = fields;
    }

    return {raw, problems};
}

//Хост из игрового адреса host:port. Порт отрезается по последнему двоеточию — так работает и IPv6
//в квадратных скобках.
function hostOf(gameAddress: string): string {
    const separator = gameAddress.lastIndexOf(":");

    return separator > 0 ? gameAddress.slice(0, separator) : gameAddress;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
