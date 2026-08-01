import test from "node:test";
import assert from "node:assert/strict";
import {mergeQueryResults} from "./mergeQueryResults.js";

test("пустой список источников даёт пустой результат", () => {
    assert.deepEqual(mergeQueryResults([]), {});
});

test("единственный источник отдаётся как есть", () => {
    assert.deepEqual(
        mergeQueryResults([{players: 10, maxPlayers: 64}]),
        {players: 10, maxPlayers: 64},
    );
});

test("не ответивший источник пропускается", () => {
    assert.deepEqual(
        mergeQueryResults([undefined, {players: 10, maxPlayers: 64}]),
        {players: 10, maxPlayers: 64},
    );
});

test("все источники промолчали — результат пустой, а не undefined", () => {
    //Пустой объект означает "сервер опрошен, ничего не известно". Отсутствие данных
    //отличается от отсутствия ответа главного источника: второе живёт в ServerPollResult.alive.
    assert.deepEqual(mergeQueryResults([undefined, undefined]), {});
});

test("при совпадении поля выигрывает источник с более высоким приоритетом", () => {
    assert.deepEqual(
        mergeQueryResults([
            {players: 10, maxPlayers: 64},
            {players: 3, maxPlayers: 32},
        ]),
        {players: 10, maxPlayers: 64},
    );
});

test("поля собираются из разных источников", () => {
    //Ради этого всё и затевалось: источник, который умеет только часть полей, дополняет остальные,
    //а не заменяет их целиком.
    assert.deepEqual(
        mergeQueryResults([{players: 10}, {maxPlayers: 64}]),
        {players: 10, maxPlayers: 64},
    );
});

test("источник с высоким приоритетом не затирает поле, которого у него нет", () => {
    assert.deepEqual(
        mergeQueryResults([{players: 10}, {players: 3, maxPlayers: 32}]),
        {players: 10, maxPlayers: 32},
    );
});

test("явный undefined в поле равнозначен отсутствию поля", () => {
    //Querier может собрать результат со всеми полями и часть оставить неопределённой:
    //для слияния это то же самое, что поля не было.
    assert.deepEqual(
        mergeQueryResults([{players: undefined, maxPlayers: 64}, {players: 3}]),
        {players: 3, maxPlayers: 64},
    );
});

test("ноль игроков — это значение, а не отсутствие данных", () => {
    //Пустой сервер онлайн: players: 0 должен победить, а не провалиться к следующему источнику.
    assert.deepEqual(
        mergeQueryResults([{players: 0}, {players: 42}]),
        {players: 0},
    );
});
