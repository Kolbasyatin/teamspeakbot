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

function buttons(keyboard: {inline_keyboard: {text: string; callback_data?: string}[][]}): [string, string][] {
    return keyboard.inline_keyboard.flat().map(button => [button.text, button.callback_data ?? ""]);
}

test("действие карточки переживает кодирование и разбор", () => {
    const action: CardAction = {action: "toggleEvent", serverId: 7, kind: "roundFinish"};

    assert.deepEqual(decodeCardAction(encodeCardAction(action)), action);
});

test("действия без типа разбираются с пустым типом", () => {
    const action: CardAction = {action: "unsubscribe", serverId: 7, kind: undefined};

    assert.deepEqual(decodeCardAction(encodeCardAction(action)), action);
});

test("испорченная кнопка карточки не разбирается", () => {
    assert.equal(decodeCardAction("мусор"), undefined);
    assert.equal(decodeCardAction("k:x:7:"), undefined);
    assert.equal(decodeCardAction("k:e:абв:"), undefined);
});

test("шаблоны карточки и списка не пересекаются", () => {
    //Иначе одна кнопка попала бы в оба обработчика, и порядок регистрации решал бы, что произойдёт.
    const cardData = encodeCardAction({action: "toggleEvent", serverId: 7, kind: "availability"});

    assert.ok(CARD_ACTION_PATTERN.test(cardData));
    assert.ok(!LIST_ACTION_PATTERN.test(cardData));
    assert.ok(!CARD_ACTION_PATTERN.test("c:t:7:0:"));
});

test("включённые уведомления помечены галочкой", () => {
    const enabled = new Set<SubscriptionEventKind>(["availability"]);

    assert.deepEqual(
        buttons(renderServerCard(server, enabled).keyboard).map(([text]) => text),
        ["✅ падения и подъёмы", "▫️ конец раунда", "🗑 Отписаться", "◀ К списку"],
    );
});

test("выключенные все — карточка говорит об этом прямо", () => {
    //Иначе человек видит подписку, которая молчит, и считает это поломкой.
    const {text} = renderServerCard(server, new Set());

    assert.match(text, /Ничего не присылаю/);
});

test("имя и адрес экранируются", () => {
    const {text} = renderServerCard({id: 1, name: "<b>злой</b>", gameAddress: "a&b"}, new Set());

    assert.match(text, /&lt;b&gt;злой&lt;\/b&gt;/);
    assert.match(text, /a&amp;b/);
});
