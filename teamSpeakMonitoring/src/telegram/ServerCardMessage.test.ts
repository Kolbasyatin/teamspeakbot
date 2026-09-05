import test from "node:test";
import assert from "node:assert/strict";
import {
    CARD_ACTION_PATTERN,
    decodeCardAction,
    encodeCardAction,
    renderServerCard,
    type CardAction,
} from "./ServerCardMessage.js";
import {LIST_ACTION_PATTERN} from "./ServerListMessage.js";
import type {SubscriptionEventKind} from "./SubscriptionEvent.js";

const server = {id: 7, name: "Первый", gameAddress: "127.0.0.1:2001"};
const origin = {view: "catalog", page: 2, search: "arma"} as const;

function buttons(keyboard: {inline_keyboard: {text: string; callback_data?: string}[][]}): [string, string][] {
    return keyboard.inline_keyboard.flat().map(button => [button.text, button.callback_data ?? ""]);
}

test("действие карточки переживает кодирование и разбор", () => {
    const action: CardAction = {action: "toggleEvent", serverId: 7, kind: "roundFinish", origin};

    assert.deepEqual(decodeCardAction(encodeCardAction(action)), action);
});

test("действия без типа разбираются с пустым типом", () => {
    const action: CardAction = {action: "unsubscribe", serverId: 7, kind: undefined, origin};

    assert.deepEqual(decodeCardAction(encodeCardAction(action)), action);
});

test("испорченная кнопка карточки не разбирается", () => {
    assert.equal(decodeCardAction("мусор"), undefined);
    assert.equal(decodeCardAction("k:x:7::c:0:"), undefined);
    assert.equal(decodeCardAction("k:e:абв::c:0:"), undefined);
    //Старый формат без происхождения — кнопка из сообщения до смены формата.
    assert.equal(decodeCardAction("k:e:7:availability"), undefined);
});

test("шаблоны карточки и списка не пересекаются", () => {
    //Иначе одна кнопка попала бы в оба обработчика, и порядок регистрации решал бы, что произойдёт.
    const cardData = encodeCardAction({action: "toggleEvent", serverId: 7, kind: "availability", origin});

    assert.ok(CARD_ACTION_PATTERN.test(cardData));
    assert.ok(!LIST_ACTION_PATTERN.test(cardData));
    assert.ok(!CARD_ACTION_PATTERN.test("c:o:7:0:"));
});

test("у подписанного — галочки по типам, проверка, отписка и возврат", () => {
    const enabled = new Set<SubscriptionEventKind>(["availability"]);

    assert.deepEqual(
        buttons(renderServerCard(server, true, enabled, origin).keyboard).map(([text]) => text),
        ["✅ падения и подъёмы", "▫️ конец раунда", "🔍 Проверить", "🗑 Отписаться", "◀ К списку"],
    );
});

test("у неподписанного — подписаться, проверка и возврат, без настроек", () => {
    //Проверка не зависит от подписки: ради этого карточка и открывается из каталога.
    const {text, keyboard} = renderServerCard(server, false, new Set(), origin);

    assert.deepEqual(
        buttons(keyboard).map(([text]) => text),
        ["➕ Подписаться", "🔍 Проверить", "◀ К списку"],
    );
    assert.match(text, /не подписан/);
});

test("каждая кнопка карточки помнит, откуда карточку открыли", () => {
    //Иначе после переключения галочки «◀ К списку» вёл бы на первую страницу без поиска.
    const {keyboard} = renderServerCard(server, true, new Set(), origin);

    for (const [, data] of buttons(keyboard)) {
        assert.deepEqual(decodeCardAction(data)?.origin, origin);
    }
});

test("выключенные все — карточка говорит об этом прямо", () => {
    //Иначе человек видит подписку, которая молчит, и считает это поломкой.
    const {text} = renderServerCard(server, true, new Set(), origin);

    assert.match(text, /Ничего не присылаю/);
});

test("имя и адрес экранируются", () => {
    const {text} = renderServerCard({id: 1, name: "<b>злой</b>", gameAddress: "a&b"}, true, new Set(), origin);

    assert.match(text, /&lt;b&gt;злой&lt;\/b&gt;/);
    assert.match(text, /a&amp;b/);
});
