import type {ServerQueryResult} from "./ServerQuery.js";

//Слияние ответов нескольких источников одного сервера в один результат.
//Чистая функция, потому что ни сети, ни БД для этого не нужно — нужны фикстуры.
//
//Правило одно: поле за полем, побеждает первое определённое значение. Никакой настройки
//"источник X отвечает за поле Y" нет и не планируется: что источник умеет отдать — свойство его
//типа, то есть кода querier'а (A2S не знает длины очереди, сколько его ни настраивай).
//Настраивается только приоритет, то есть порядок аргументов здесь.

//Поля, участвующие в слиянии. Record, а не массив: компилятор требует ключ для КАЖДОГО поля
//ServerQueryResult, поэтому добавили поле в интерфейс — сборка падает, пока его не внесли сюда.
//Без этой проверки забытое поле не сломало бы ничего заметного: оно просто молча оставалось бы
//undefined после слияния, то есть данные источника терялись бы без единой ошибки.
const MERGEABLE_FIELDS: Record<keyof ServerQueryResult, true> = {
    players: true,
    maxPlayers: true,
};

//results — в порядке убывания приоритета. undefined на месте источника означает "не ответил":
//он просто не участвует, а не обнуляет поле, уже заполненное источником повыше.
export function mergeQueryResults(
    results: readonly (ServerQueryResult | undefined)[],
): ServerQueryResult {
    const merged: ServerQueryResult = {};

    for (const field of Object.keys(MERGEABLE_FIELDS) as (keyof ServerQueryResult)[]) {
        for (const result of results) {
            const value = result?.[field];

            if (value !== undefined) {
                merged[field] = value;
                break;
            }
        }
    }

    return merged;
}
