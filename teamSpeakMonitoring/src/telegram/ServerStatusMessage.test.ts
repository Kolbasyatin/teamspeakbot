import test from "node:test";
import assert from "node:assert/strict";
import {renderServerCheck, renderServerStatus} from "./ServerStatusMessage.js";
import {snapshotFixture} from "../test/serverFixtures.js";

//Момент времени задаётся явно, поэтому текст детерминирован целиком: snapshotFixture ставит
//statusSince в эпоху, а «сейчас» мы выбираем сами.
const NOW = new Date(2 * 60 * 60 * 1000 + 15 * 60 * 1000);

test("пустые подписки зовут в каталог", () => {
    assert.match(renderServerStatus([], [], NOW).text, /\/serverlist/);
});

test("имя и факты стоят на разных строках", () => {
    //Ради этого вёрстка и переделана: в одну строку длинное имя не помещается, и телефон рвёт
    //его как попало, разрывая «27/64» и время.
    const text = renderServerStatus(
        [snapshotFixture({id: 1, name: "Первый", status: "online", players: 27, maxPlayers: 64})],
        [],
        NOW,
    ).text;

    assert.match(text, /🟢 <b>Первый<\/b>\n👥 27\/64 {3}⏱ 2 часа 15 минут/);
});

test("упавший сервер не показывает чисел", () => {
    //У offline данных нет по построению: currentInfo отдаётся, только пока статус их подтверждает.
    const text = renderServerStatus(
        [snapshotFixture({id: 1, name: "Первый", status: "offline"})],
        [],
        NOW,
    ).text;

    assert.match(text, /🔴 <b>Первый<\/b>\n⏱ офлайн 2 часа 15 минут/);
});

test("живой сервер без данных так и говорит, а не показывает ноль", () => {
    //Бывает до первого удачного опроса и когда ответил источник, который игроков не отдаёт.
    const text = renderServerStatus(
        [snapshotFixture({id: 1, name: "Первый", status: "unknown"})],
        [],
        NOW,
    ).text;

    assert.match(text, /👥 нет данных/);
});

test("подписка на скрытый сервер видна отдельной строкой", () => {
    //Сервер убрали из каталога уже после подписки: опроса нет, снимка нет. Промолчать нельзя —
    //иначе список короче, чем подписки, и человек не поймёт почему.
    const text = renderServerStatus([], [{name: "Скрытый"}], NOW).text;

    assert.match(text, /⚪ <b>Скрытый<\/b>\nне отслеживается/);
});

test("угловые скобки в имени экранируются", () => {
    //Незакрытый «<» в названии — это не кривая вёрстка, а отказ Telegram разобрать сообщение,
    //то есть /status перестанет отвечать вообще.
    const text = renderServerStatus([], [{name: "<b>злое</b> & имя"}], NOW).text;

    assert.match(text, /⚪ <b>&lt;b&gt;злое&lt;\/b&gt; &amp; имя<\/b>/);
});

test("в заголовке считаются и отслеживаемые, и скрытые", () => {
    const text = renderServerStatus(
        [snapshotFixture({id: 1, name: "Первый", status: "online", players: 1})],
        [{name: "Скрытый"}],
        NOW,
    ).text;

    assert.match(text, /Твои серверы: 2/);
});

test("статус моложе минуты не показывается пустой строкой", () => {
    const text = renderServerStatus(
        [snapshotFixture({id: 1, name: "Первый", status: "online", players: 1})],
        [],
        new Date(30 * 1000),
    ).text;

    assert.match(text, /меньше минуты/);
});

test("отметка времени меняется, даже когда данные те же", () => {
    //Без неё повторное нажатие «Обновить» даёт байт в байт тот же текст, Telegram отвечает
    //«message is not modified», и кнопка выглядит сломанной.
    const server = snapshotFixture({id: 1, name: "Первый", status: "online", players: 27});

    const first = renderServerStatus([server], [], new Date(3600 * 1000)).text;
    const second = renderServerStatus([server], [], new Date(3600 * 1000 + 5000)).text;

    assert.notEqual(first, second);
});

test("кнопка обновления есть всегда, в том числе у пустого списка", () => {
    const {keyboard} = renderServerStatus([], [], NOW);

    assert.deepEqual(
        keyboard.inline_keyboard.flat().map(button => button.text),
        ["🔄 Обновить"],
    );
});

test("очередь показывается отдельной строкой со свежестью данных", () => {
    //Свежесть стоит у очереди, а не у игроков: игроки приезжают по A2S с каждым опросом,
    //очередь — из каталога Bohemia с задержкой heartbeat'а.
    const text = renderServerStatus(
        [snapshotFixture({
            id: 1, name: "Первый", status: "online", players: 128, maxPlayers: 128,
            info: {queueSize: 7, queueMaxSize: 50, dataUpdatedAt: NOW.getTime() - 3 * 60 * 1000},
        })],
        [],
        NOW,
    ).text;

    assert.match(text, /👥 128\/128 {3}⏱ 2 часа 15 минут\n⏳ очередь 7\/50 · 3 минуты назад/);
});

test("пустая очередь — самостоятельный факт, данные моложе минуты — «только что»", () => {
    const text = renderServerStatus(
        [snapshotFixture({
            id: 1, name: "Первый", status: "online", players: 128, maxPlayers: 128,
            info: {queueSize: 0, dataUpdatedAt: NOW.getTime() - 20 * 1000},
        })],
        [],
        NOW,
    ).text;

    assert.match(text, /⏳ без очереди · только что/);
});

test("без источника очереди строки про очередь нет", () => {
    const text = renderServerStatus(
        [snapshotFixture({id: 1, name: "Первый", status: "online", players: 27, maxPlayers: 64})],
        [],
        NOW,
    ).text;

    assert.doesNotMatch(text, /⏳/);
});

test("очередь без свежести показывается без хвоста", () => {
    const text = renderServerStatus(
        [snapshotFixture({id: 1, name: "Первый", status: "online", players: 1, info: {queueSize: 3}})],
        [],
        NOW,
    ).text;

    assert.match(text, /⏳ очередь 3\n/);
});

//Разовая проверка: сервер из каталога, без probe и без подписки.
const CHECKED = {id: 7, name: "Первый", gameAddress: "127.0.0.1:2001"};

test("разовая проверка показывает игроков и очередь тем же языком, что /status", () => {
    const text = renderServerCheck(CHECKED, {
        alive: true,
        info: {players: 27, maxPlayers: 64, queueSize: 3, dataUpdatedAt: NOW.getTime() - 20 * 1000},
    }, NOW);

    assert.match(text, /🟢 <b>Первый<\/b>\n<code>127\.0\.0\.1:2001<\/code>\n👥 27\/64\n⏳ очередь 3 · только что/);
    assert.match(text, /<i>проверено \d\d:\d\d:\d\d<\/i>/);
});

test("разовая проверка не называет молчание офлайном", () => {
    //Антидребезга у разового запроса нет: одна потерянная датаграмма — не упавший сервер.
    const text = renderServerCheck(CHECKED, {alive: false, info: {}}, NOW);

    assert.match(text, /🔴 <b>Первый<\/b>\n<code>127\.0\.0\.1:2001<\/code>\nне ответил на запрос/);
    assert.doesNotMatch(text, /офлайн|👥/);
});

test("ответивший сервер без чисел так и говорит", () => {
    const text = renderServerCheck(CHECKED, {alive: true, info: {}}, NOW);

    assert.match(text, /👥 нет данных/);
    assert.doesNotMatch(text, /⏳/);
});
