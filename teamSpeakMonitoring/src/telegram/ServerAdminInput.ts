//Разбор аргументов команд управления серверами. Чистые функции: проверяются без grammy.
//
//Формат — «ключ=значение» через пробел. Значение тянется до следующего «ключ=», поэтому пробелы
//в нём кавычек не требуют: name=#1 ARMA RUSSIAN address=1.2.3.4:2001 разбирается как два параметра.
//С телефона кавычки набирать неудобно, а имена серверов почти всегда с пробелами.

export interface ParsedArguments {
    //Всё, что стоит до первого «ключ=»: id, тип источника.
    positional: string[];
    params: Record<string, string>;
    problems: string[];
}

//Ключ — латиница, цифры, точка и подчёркивание (fields.players, hostAddress). Перед ним пробел
//или начало строки: «=» внутри url (?a=1) ключом не считается.
const KEY = /(^|\s)([A-Za-z][\w.]*)=/g;

export function parseArguments(text: string): ParsedArguments {
    const matches = [...text.matchAll(KEY)];
    const firstAt = matches[0]?.index ?? text.length;
    const positional = text.slice(0, firstAt).trim().split(/\s+/).filter(token => token !== "");
    const params: Record<string, string> = {};
    const problems: string[] = [];

    for (const [index, match] of matches.entries()) {
        const key = match[2] ?? "";
        const valueStart = (match.index ?? 0) + match[0].length;
        const valueEnd = matches[index + 1]?.index ?? text.length;

        if (Object.hasOwn(params, key)) {
            problems.push(`параметр ${key} указан дважды`);
        }

        params[key] = text.slice(valueStart, valueEnd).trim();
    }

    return {positional, params, problems};
}

//Положительный целый id из позиционного аргумента.
export function parseId(raw: string | undefined): number | undefined {
    return raw !== undefined && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : undefined;
}

//«/server_add Имя сервера | 1.2.3.4:2001» — имя с пробелами и адрес через черту. Другой формат,
//чем у остальных команд, потому что у нового сервера ровно два поля и оба обязательны.
//Форма name=… address=… тоже принимается — для единообразия с /server_edit.
export function parseNewServer(text: string): {name: string; address: string} | undefined {
    const separator = text.lastIndexOf("|");

    if (separator >= 0) {
        return {name: text.slice(0, separator).trim(), address: text.slice(separator + 1).trim()};
    }

    const {params} = parseArguments(text);

    return params["name"] !== undefined && params["address"] !== undefined
        ? {name: params["name"], address: params["address"]}
        : undefined;
}
