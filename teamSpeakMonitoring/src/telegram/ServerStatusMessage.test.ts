import test from "node:test";
import assert from "node:assert/strict";
import {renderServerStatus} from "./ServerStatusMessage.js";
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
