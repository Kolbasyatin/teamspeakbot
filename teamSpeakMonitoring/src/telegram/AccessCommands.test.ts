import test from "node:test";
import assert from "node:assert/strict";
import type {Message} from "grammy/types";
import {parseRoleCommand, renderRoleCatalog, resolveTarget} from "./AccessCommands.js";

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
