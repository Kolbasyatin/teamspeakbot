import test from "node:test";
import assert from "node:assert/strict";
import {
    CHAT_HISTORY_PAGE_SIZE,
    decodeChatHistoryPage,
    encodeChatHistoryPage,
    renderChatHistory,
    type ChatHistoryEntry,
} from "./ChatHistoryMessage.js";
import {callbackPermission} from "./commandAccess.js";

const AT = new Date("2026-11-24T12:00:00Z");
const ME = 168350674;

function render(entries: ChatHistoryEntry[], total = entries.length): string {
    return renderChatHistory({chatId: ME, chat: undefined, isRoot: false, entries, total, page: 0}).text;
}

test("каждый вид записи читается одной строкой со временем по Москве", () => {
    const text = render([
        {kind: "command", at: AT, userId: ME, name: "watch", arguments: "Zalex", known: true, allowed: true},
        {kind: "command", at: AT, userId: ME, name: "players", arguments: undefined, known: true, allowed: false},
        {kind: "command", at: AT, userId: ME, name: "nosuch", arguments: undefined, known: false, allowed: false},
        {kind: "button", at: AT, userId: ME, name: "k:o:1", arguments: undefined, known: true, allowed: true},
        {kind: "grant", at: AT, role: "ROLE_SERVER_USER", actorUserId: undefined, note: "по умолчанию при /start"},
        {kind: "grant", at: AT, role: "ROLE_TS_USER", actorUserId: 7, note: "клан"},
        {kind: "revoke", at: AT, role: "ROLE_TS_USER", actorUserId: 7, note: undefined},
        {kind: "feedback", at: AT, feedbackId: 12, text: "Добавьте EXD #3", userId: ME},
        {kind: "reply", at: AT, feedbackId: 12, text: "Добавили", delivered: false},
    ]);

    assert.match(text, /24\.11\.26, 15:00 ⌨️ \/watch Zalex$/m);
    assert.match(text, /⛔ \/players — нет прав$/m);
    assert.match(text, /❔ \/nosuch — нет такой$/m);
    assert.match(text, /🔘 кнопка k:o:1$/m);
    assert.match(text, /➕ выдана server_user — автоматически · «по умолчанию при \/start»/);
    assert.match(text, /➕ выдана ts_user — кем <code>7<\/code> · «клан»/);
    assert.match(text, /➖ отозвана ts_user — кем <code>7<\/code>$/m);
    assert.match(text, /✉️ #12: Добавьте EXD #3$/m);
    assert.match(text, /💬 ответ на #12 \(не доставлен\): Добавили/);
});

test("в группе видно, кто из участников набрал команду; чужой ввод экранируется", () => {
    const text = renderChatHistory({
        chatId: -100,
        chat: undefined,
        isRoot: false,
        entries: [{kind: "command", at: AT, userId: 7, name: "watch", arguments: "<b>x</b>", known: true, allowed: true}],
        total: 1,
        page: 0,
    }).text;

    assert.match(text, /\/watch &lt;b&gt;x&lt;\/b&gt; · от <code>7<\/code>/);
    assert.match(text, /<code>-100<\/code> — в списке чатов нет/);
});

test("листание истории: кнопки несут chat_id, требуют права на список чатов", () => {
    const {keyboard} = renderChatHistory({chatId: -100, chat: undefined, isRoot: false, entries: [], total: CHAT_HISTORY_PAGE_SIZE + 1, page: 0});
    const data = (keyboard?.inline_keyboard.flat() ?? []).map(button => "callback_data" in button ? button.callback_data : "");

    assert.deepEqual(data, ["cht:-100:1"]);
    assert.deepEqual(decodeChatHistoryPage(encodeChatHistoryPage(-100, 3)), {chatId: -100, page: 3});
    assert.equal(callbackPermission("cht:-100:1"), "ROLE_CHAT_LIST");
});

test("худший случай — страница длинных аргументов из «<» — всё равно влезает в сообщение Telegram", () => {
    const entries: ChatHistoryEntry[] = Array.from({length: CHAT_HISTORY_PAGE_SIZE}, () => ({
        kind: "command", at: AT, userId: 7, name: "watch", arguments: "<".repeat(255), known: true, allowed: false,
    }));
    const text = renderChatHistory({chatId: -1003738458034, chat: undefined, isRoot: false, entries, total: 500, page: 3}).text;

    assert.ok(text.length <= 4096, `длина ${text.length}`);
});
