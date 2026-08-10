import test from "node:test";
import assert from "node:assert/strict";
import {RoundFinishWatcher, type RoundFinishPublisher} from "./RoundFinishWatcher.js";
import {InMemoryPlayerHistory} from "./PlayerHistory.js";
import type {NotificationEvent} from "../notifications/events.js";
import {snapshotFixture} from "../test/serverFixtures.js";
import type {ServerStatus} from "../monitoring/ServerProbe.js";

const OPTIONS = {windowMs: 60_000, drop: 0.25, minBase: 20, emptyPlayers: 2};
const TICK_MS = 5_000;

interface Recorder extends RoundFinishPublisher {
    events: NotificationEvent[];
}

function createRecorder(): Recorder {
    return {
        events: [],
        notify(event: NotificationEvent): Promise<void> {
            this.events.push(event);
            return Promise.resolve();
        },
    };
}

//Прогон ряда значений через наблюдателя с шагом в один опрос. Значение undefined означает,
//что сервер не ответил, число — сколько игроков.
async function feed(
    values: readonly (number | undefined)[],
    status: (value: number | undefined) => ServerStatus = value => (value === undefined ? "offline" : "online"),
): Promise<Recorder> {
    const recorder = createRecorder();
    let at = 1_000_000;
    const watcher = new RoundFinishWatcher(
        new InMemoryPlayerHistory(OPTIONS.windowMs),
        recorder,
        OPTIONS,
        () => at,
    );

    for (const value of values) {
        await watcher.notify({
            type: "serverStateUpdated",
            snapshots: [snapshotFixture({
                id: 1,
                status: status(value),
                ...(value === undefined ? {} : {players: value, maxPlayers: 128}),
            })],
        });
        at += TICK_MS;
    }

    return recorder;
}

//Плато перед спадом. Шестнадцати замеров хватает, чтобы заполнить минутное окно.
const PLATEAU = Array.from({length: 16}, () => 125);

test("настоящий спад из прод-логов ловится", async () => {
    //Ряд взят из tsbot.log, эпизод 11:03:49 — типичная форма: плато, потом обвал за несколько замеров.
    const recorder = await feed([...PLATEAU, 127, 117, 92, 80, 70, 68, 63]);

    assert.equal(recorder.events.length, 1);
    assert.equal(recorder.events[0]?.type, "roundFinish");
});

test("сигнал уходит один раз на эпизод, а не на каждый замер спада", async () => {
    //Спад длится полминуты; без этого пришло бы сообщений по числу замеров.
    const recorder = await feed([...PLATEAU, 127, 117, 92, 80, 70, 68, 63, 60, 57, 54]);

    assert.equal(recorder.events.length, 1);
});

test("в сигнале видно, с чего упали", async () => {
    const recorder = await feed([...PLATEAU, 127, 117, 92]);
    const event = recorder.events[0];

    assert.equal(event?.type === "roundFinish" && event.playersBefore, 127);
});

test("пологий отток вечером не считается концом раунда", async () => {
    //Люди расходятся сами: за минуту теряется меньше четверти.
    const recorder = await feed([...PLATEAU, 124, 122, 120, 118, 116, 114, 112]);

    assert.deepEqual(recorder.events, []);
});

test("спад с малого числа игроков не считается", async () => {
    //4 → 1 это не конец раунда, а два человека вышли.
    const recorder = await feed([...Array.from({length: 16}, () => 6), 4, 1]);

    assert.deepEqual(recorder.events, []);
});

test("сервер не ответил — замера нет, обвала нет", async () => {
    //«Неизвестно» это не ноль: иначе любой пропуск опроса выглядел бы как конец раунда.
    const recorder = await feed(
        [...PLATEAU, undefined, undefined, 125],
        value => (value === undefined ? "unknown" : "online"),
    );

    assert.deepEqual(recorder.events, []);
});

test("после перезапуска возврат сервера с нуля не считается обвалом", async () => {
    //Главный источник ложных срабатываний в разборе логов: окно ещё помнило доперезапускные
    //значения, и наполняющийся сервер выглядел как рухнувший.
    const recorder = await feed([...PLATEAU, undefined, 0, 1, 14, 30, 43, 54, 66]);

    assert.deepEqual(recorder.events, []);
});

test("обнуление без ухода в offline тоже считается перезапуском", async () => {
    //Три случая из 22 в логах: A2S отвечает, а счётчик обнулился — сервер перезапустил раунд,
    //всех кикнув. По статусу этого не видно.
    const recorder = await feed([...PLATEAU, 0, 1, 14, 30, 43, 54, 66], () => "online");

    assert.deepEqual(recorder.events, []);
});

test("следующий раунд снова даёт сигнал", async () => {
    //Эпизод закрывается возвратом к базе; иначе сигнал был бы ровно один за всё время работы.
    const recorder = await feed([
        ...PLATEAU, 127, 117, 92, 70,
        //перезапуск и наполнение
        undefined, 0, 20, 60, 100, 124, 126, 125, 125, 125, 125, 125, 125, 125, 125, 125, 125, 125,
        //следующий конец раунда
        126, 118, 88, 70,
    ]);

    assert.equal(recorder.events.length, 2);
});
