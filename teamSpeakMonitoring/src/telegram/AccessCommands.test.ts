import test from "node:test";
import assert from "node:assert/strict";
import type {Message} from "grammy/types";
import {parseRoleCommand, renderChatRoles, renderRoleCatalog, replyAuthor, resolveTarget} from "./AccessCommands.js";
import type {RoleAssignment} from "../access/AccessControl.js";

const PRIVATE = {id: 100, type: "private"};
const GROUP = {id: -1001234567890, type: "supergroup"};

function replyFrom(id: number, extra: Partial<Message> = {}): Message {
    return {from: {id, is_bot: false, first_name: "Вася"}, ...extra} as Message;
}

test("явный id, роль и заметка", () => {
    assert.deepEqual(parseRoleCommand("555 player_user Вася из клана"), {
        targetChatId: 555,
        rawRole: "player_user",
        note: "Вася из клана",
    });
});

test("отрицательный id группы распознаётся как адресат", () => {
    assert.equal(parseRoleCommand("-1001234567890 ROLE_TS_VIEW").targetChatId, -1001234567890);
});

test("без id: первая лексема — роль", () => {
    assert.deepEqual(parseRoleCommand("  ROLE_PLAYER_USER  "), {
        targetChatId: undefined,
        rawRole: "ROLE_PLAYER_USER",
        note: undefined,
    });
});

test("пустая команда — роли нет", () => {
    assert.equal(parseRoleCommand("").rawRole, undefined);
    assert.equal(parseRoleCommand("555").rawRole, undefined);
});

test("адресат: явный id важнее ответа", () => {
    assert.equal(resolveTarget(555, GROUP, replyFrom(777)), 555);
});

test("адресат: ответом на сообщение — тот, кто его написал", () => {
    assert.equal(resolveTarget(undefined, GROUP, replyFrom(777)), 777);
});

test("адресат: в группе без ответа — сама группа", () => {
    assert.equal(resolveTarget(undefined, GROUP, undefined), GROUP.id);
});

test("адресат: в личке без id не угадывается", () => {
    assert.equal(resolveTarget(undefined, PRIVATE, undefined), undefined);
});

test("ответ боту — не указание на человека", () => {
    const fromBot = {from: {id: 999, is_bot: true, first_name: "TsBot"}} as Message;

    assert.equal(resolveTarget(undefined, GROUP, fromBot), GROUP.id);
});

test("служебное сообщение о создании темы — не указание на человека", () => {
    //В супергруппе с темами каждое сообщение формально отвечает на это служебное сообщение.
    const topic = replyFrom(777, {forum_topic_created: {name: "Общее", icon_color: 0}});

    assert.equal(resolveTarget(undefined, GROUP, topic), GROUP.id);
});

test("справочник ролей показывает команды каждого права", () => {
    const catalog = renderRoleCatalog().join("\n");

    assert.match(catalog, /ROLE_PLAYER_DOSSIER: \/playerinfo \/steaminfo/);
    assert.match(catalog, /ROLE_ROOT: ROLE_PLAYER_USER, ROLE_USER_ADMIN/);
    assert.doesNotMatch(catalog, /ROLE_ANONYMOUS:/);
});

function assignment(role: string, extra: Partial<RoleAssignment> = {}): RoleAssignment {
    return {
        chatId: GROUP.id,
        role,
        grantedBy: undefined,
        grantedAt: new Date("2026-10-16T12:00:00Z"),
        note: undefined,
        chatTitle: "Клан",
        ...extra,
    };
}

test("роли чата: кто выдал, когда, заметка и итоговые команды", () => {
    const text = renderChatRoles({
        chatId: GROUP.id,
        chat: {chatId: GROUP.id, type: "supergroup", title: "Клан"},
        isRoot: false,
        assignments: [
            assignment("ROLE_PLAYER_USER", {grantedBy: 123, note: "наш клан"}),
            assignment("ROLE_SERVER_USER"),
        ],
        commands: ["serverlist", "watch"],
    }).join("\n");

    assert.match(text, /Чат -1001234567890 «Клан» \(supergroup\)/);
    assert.match(text, /ROLE_PLAYER_USER — выдал 123, 16\.10\.2026, «наш клан»/);
    assert.match(text, /ROLE_SERVER_USER — по умолчанию, 16\.10\.2026/);
    assert.match(text, /Доступные команды: \/serverlist \/watch/);
});

test("роли чата: root из конфига виден, даже если в базе пусто", () => {
    const text = renderChatRoles({
        chatId: 100,
        chat: undefined,
        isRoot: true,
        assignments: [],
        commands: ["roles"],
    }).join("\n");

    assert.match(text, /ROLE_ROOT — из конфигурации/);
    assert.doesNotMatch(text, /Боту не писал/);
});

test("роли чата: незнакомый чат и мёртвое назначение названы прямо", () => {
    const unknown = renderChatRoles({chatId: 555, chat: undefined, isRoot: false, assignments: [], commands: []});

    assert.match(unknown.join("\n"), /Боту не писал/);
    assert.match(unknown.join("\n"), /Ролей нет\./);

    //Роль переименовали в коде, а строка в базе осталась: «выдана, но не работает» должно быть видно.
    const dead = renderChatRoles({
        chatId: 100,
        chat: {chatId: 100, type: "private", title: "Вася"},
        isRoot: false,
        assignments: [assignment("ROLE_SUPER_USER")],
        commands: [],
    });

    assert.match(dead.join("\n"), /ROLE_SUPER_USER — нет в коде, не действует/);
});

test("автор ответа: человек — да, бот и тема — нет", () => {
    assert.equal(replyAuthor(replyFrom(777)), 777);
    assert.equal(replyAuthor(undefined), undefined);
    assert.equal(replyAuthor({from: {id: 9, is_bot: true, first_name: "Bot"}} as Message), undefined);
    assert.equal(replyAuthor(replyFrom(777, {forum_topic_created: {name: "Общее", icon_color: 0}})), undefined);
});
