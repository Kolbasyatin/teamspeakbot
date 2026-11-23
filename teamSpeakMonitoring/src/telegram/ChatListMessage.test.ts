import test from "node:test";
import assert from "node:assert/strict";
import {
    CHAT_LIST_PAGE_SIZE,
    clampPage,
    decodeChatListPage,
    encodeChatListPage,
    renderChatList,
    type ChatListEntry,
} from "./ChatListMessage.js";
import {callbackPermission} from "./commandAccess.js";

function entry(overrides: Partial<ChatListEntry> = {}): ChatListEntry {
    return {
        chatId: 168350674,
        type: "private",
        title: "Kolbasyatin",
        firstSeenAt: new Date("2026-09-25T12:00:00Z"),
        roles: ["ROLE_SERVER_USER"],
        serverSubscriptions: 0,
        lists: [],
        blocked: false,
        ...overrides,
    };
}

const noRoot = (): boolean => false;

test("строка чата: значок, имя, id, дата первого появления, роли в форме для /grant, подписки", () => {
    const {text} = renderChatList({
        entries: [entry({roles: ["ROLE_PLAYER_USER", "ROLE_TS_USER"], serverSubscriptions: 2})],
        counts: {total: 1, private: 1},
        page: 0,
        isRoot: noRoot,
    });

    assert.match(text, /👤 Kolbasyatin — <code>168350674<\/code>/);
    assert.match(text, /с 25\.09\.2026 · player_user, ts_user · подписок 2/);
});

test("root из конфигурации отмечен, хотя в базе его нет", () => {
    const {text} = renderChatList({
        entries: [entry()],
        counts: {total: 1, private: 1},
        page: 0,
        isRoot: chatId => chatId === 168350674,
    });

    assert.match(text, /root, server_user/);
});

test("группа, чат без ролей и без имени", () => {
    const {text} = renderChatList({
        entries: [entry({chatId: -1003738458034, type: "supergroup", title: undefined, roles: []})],
        counts: {total: 1, private: 0},
        page: 0,
        isRoot: noRoot,
    });

    assert.match(text, /👥 без имени — <code>-1003738458034<\/code>/);
    assert.match(text, /без ролей/);
    assert.match(text, /личек 0, групп и каналов 1/);
});

test("имя из базы экранируется и обрезается: оно чужое и может сломать HTML", () => {
    const {text} = renderChatList({
        entries: [entry({title: `<script>${"x".repeat(60)}`})],
        counts: {total: 1, private: 1},
        page: 0,
        isRoot: noRoot,
    });

    assert.ok(!text.includes("<script>"));
    assert.match(text, /&lt;script&gt;x+…/);
});

test("кнопок нет, пока список влезает на одну страницу", () => {
    assert.equal(renderChatList({entries: [entry()], counts: {total: 1, private: 1}, page: 0, isRoot: noRoot}).keyboard, undefined);
});

test("листание: на первой странице только «вперёд», на последней — только «назад»", () => {
    const total = CHAT_LIST_PAGE_SIZE * 2 + 1;
    const buttons = (page: number): string[] => {
        const keyboard = renderChatList({entries: [], counts: {total, private: total}, page, isRoot: noRoot}).keyboard;
        return (keyboard?.inline_keyboard.flat() ?? []).map(button => "callback_data" in button ? button.callback_data : "");
    };

    assert.deepEqual(buttons(0), ["ch:1"]);
    assert.deepEqual(buttons(1), ["ch:0", "ch:2"]);
    assert.deepEqual(buttons(2), ["ch:1"]);
});

test("страница за последней приводится к последней, отрицательная — к первой", () => {
    assert.equal(clampPage(5, CHAT_LIST_PAGE_SIZE + 1), 1);
    assert.equal(clampPage(-1, 100), 0);
    assert.equal(clampPage(3, 0), 0);
});

test("кнопка листания разбирается и требует права на список чатов", () => {
    assert.equal(decodeChatListPage(encodeChatListPage(7)), 7);
    assert.equal(decodeChatListPage("ch:x"), undefined);
    assert.equal(callbackPermission(encodeChatListPage(0)), "ROLE_CHAT_LIST");
});

test("списки рассылки и недоступность видны в строке чата", () => {
    const {text} = renderChatList({
        entries: [entry({lists: ["klan", "testers"], blocked: true})],
        counts: {total: 1, private: 1},
        page: 0,
        isRoot: noRoot,
    });

    assert.match(text, /списки: klan, testers · 🚫 недоступен/);
});
