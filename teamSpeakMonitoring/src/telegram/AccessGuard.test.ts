import test from "node:test";
import assert from "node:assert/strict";
import type {Context} from "grammy";
import {classifyUpdate, createAccessGuard, DENIED_TEXT, type AccessChecker} from "./AccessGuard.js";
import type {Permission} from "../access/Roles.js";
import {silentLogger} from "../test/silentLogger.js";

const ME = {username: "TsBot"};

function commandContext(
    text: string,
    chatId = 42,
    sender: {from?: {id: number; is_bot: boolean}; senderChat?: {id: number}} = {},
): Context & {replies: string[]; answers: string[]} {
    const commandLength = text.split(/\s/)[0]?.length ?? 0;
    const replies: string[] = [];

    return {
        me: ME,
        chatId,
        from: sender.from,
        message: {
            text,
            entities: [{type: "bot_command", offset: 0, length: commandLength}],
            ...(sender.senderChat ? {sender_chat: sender.senderChat} : {}),
        },
        replies,
        answers: [],
        reply: async (reply: string) => {
            replies.push(reply);
        },
    } as unknown as Context & {replies: string[]; answers: string[]};
}

function callbackContext(data: string, chatId = 42): Context & {answers: string[]} {
    const answers: string[] = [];

    return {
        me: ME,
        chatId,
        callbackQuery: {data},
        answers,
        answerCallbackQuery: async (text: string) => {
            answers.push(text);
        },
    } as unknown as Context & {answers: string[]};
}

function checker(granted: readonly Permission[]): AccessChecker {
    return {can: async (_chatId, permission) => granted.includes(permission)};
}

async function passes(guard: ReturnType<typeof createAccessGuard>, ctx: Context): Promise<boolean> {
    let passed = false;

    await guard(ctx, async () => {
        passed = true;
    });

    return passed;
}

test("разбор команды: имя без аргументов и без адреса своего бота", () => {
    assert.deepEqual(classifyUpdate(commandContext("/watch БЛИНК")), {kind: "command", command: "watch"});
    assert.deepEqual(classifyUpdate(commandContext("/watch@TsBot БЛИНК")), {kind: "command", command: "watch"});
    assert.deepEqual(classifyUpdate(commandContext("/watch@tsbot")), {kind: "command", command: "watch"});
});

test("команда другому боту в группе — не наш апдейт", () => {
    assert.deepEqual(classifyUpdate(commandContext("/watch@OtherBot")), {kind: "other"});
});

test("обычный текст и прочие апдейты — не команды", () => {
    assert.deepEqual(classifyUpdate({me: ME, message: {text: "привет"}} as unknown as Context), {kind: "other"});
    assert.deepEqual(classifyUpdate({me: ME} as unknown as Context), {kind: "other"});
});

test("разрешённая команда проходит дальше", async () => {
    const guard = createAccessGuard(checker(["ROLE_SERVER_LIST"]), silentLogger);

    assert.equal(await passes(guard, commandContext("/serverlist")), true);
});

test("запрещённая команда не доходит до обработчика и получает объяснение", async () => {
    const guard = createAccessGuard(checker(["ROLE_SERVER_LIST"]), silentLogger);
    const ctx = commandContext("/playerinfo БЛИНК");

    assert.equal(await passes(guard, ctx), false);
    assert.deepEqual(ctx.replies, [DENIED_TEXT]);
});

test("команда вне карты не проходит никому — fail closed", async () => {
    const everything: Permission[] = ["ROLE_ANONYMOUS", "ROLE_ACCESS_MANAGE", "ROLE_PLAYER_DOSSIER"];
    const guard = createAccessGuard(checker(everything), silentLogger);
    const ctx = commandContext("/debug");

    assert.equal(await passes(guard, ctx), false);
    //Молча: в группе ответ на каждую чужую или ошибочную команду засорял бы чат.
    assert.deepEqual(ctx.replies, []);
});

test("обычный текст до обработчиков не доходит", async () => {
    const guard = createAccessGuard(checker(["ROLE_ANONYMOUS"]), silentLogger);

    assert.equal(await passes(guard, {me: ME, chatId: 42, message: {text: "привет"}} as unknown as Context), false);
});

test("кнопка без прав подтверждается отказом и дальше не идёт", async () => {
    //Обход запрета нажатием кнопки из старого сообщения — ровно то, от чего страж стоит и на кнопках.
    const guard = createAccessGuard(checker(["ROLE_SERVER_LIST"]), silentLogger);
    const ctx = callbackContext("pi:4812");

    assert.equal(await passes(guard, ctx), false);
    assert.equal(ctx.answers.length, 1, "нажатие обязано быть подтверждено, иначе висит индикатор");
});

test("кнопка с правами проходит", async () => {
    const guard = createAccessGuard(checker(["ROLE_PLAYER_DOSSIER"]), silentLogger);

    assert.equal(await passes(guard, callbackContext("pi:4812")), true);
});

test("незнакомая кнопка подтверждается и дальше не идёт", async () => {
    const guard = createAccessGuard(checker(["ROLE_ANONYMOUS"]), silentLogger);
    const ctx = callbackContext("zz:old-format");

    assert.equal(await passes(guard, ctx), false);
    assert.equal(ctx.answers.length, 1);
});

test("кнопка без чата (inline-сообщение) не проходит", async () => {
    const guard = createAccessGuard(checker(["ROLE_PLAYER_DOSSIER"]), silentLogger);

    const ctx = {...callbackContext("pi:4812"), chatId: undefined} as unknown as Context;

    assert.equal(await passes(guard, ctx), false);
});

//Права по id: у группы одни, у человека другие — ровно то, что различают команды раздачи прав.
function checkerById(granted: Readonly<Record<number, readonly Permission[]>>): AccessChecker {
    return {can: async (id, permission) => (granted[id] ?? []).includes(permission)};
}

const GROUP = -1001234567890;
const ROOT = 100;
const VASYA = 200;
const rights = checkerById({
    [GROUP]: ["ROLE_SERVER_LIST"],
    [ROOT]: ["ROLE_ACCESS_MANAGE", "ROLE_SERVER_LIST"],
});

test("root раздаёт права в группе, у которой самой таких прав нет", async () => {
    const guard = createAccessGuard(rights, silentLogger);

    assert.equal(await passes(guard, commandContext("/grant player_user", GROUP, {from: {id: ROOT, is_bot: false}})), true);
});

test("участник группы без личных прав раздавать их не может", async () => {
    const guard = createAccessGuard(rights, silentLogger);
    const ctx = commandContext("/grant player_user", GROUP, {from: {id: VASYA, is_bot: false}});

    assert.equal(await passes(guard, ctx), false);
    assert.deepEqual(ctx.replies, [DENIED_TEXT]);
});

test("группа с правом раздачи не передаёт его участникам", async () => {
    //Проверяется человек, а не чат: права группы для раздачи прав не в счёт.
    const guard = createAccessGuard(checkerById({[GROUP]: ["ROLE_ACCESS_MANAGE"]}), silentLogger);

    assert.equal(await passes(guard, commandContext("/roles", GROUP, {from: {id: VASYA, is_bot: false}})), false);
});

test("обычные команды по-прежнему проверяются по чату", async () => {
    //Вася без личных прав пользуется правами группы, как и договаривались.
    const guard = createAccessGuard(rights, silentLogger);

    assert.equal(await passes(guard, commandContext("/serverlist", GROUP, {from: {id: VASYA, is_bot: false}})), true);
});

test("анонимный админ группы — не человек, права раздавать не может", async () => {
    //Пишет «от имени группы»: from — служебный бот, sender_chat — сама группа.
    const guard = createAccessGuard(checkerById({1087968824: ["ROLE_ACCESS_MANAGE"]}), silentLogger);
    const ctx = commandContext("/grant player_user", GROUP, {
        from: {id: 1087968824, is_bot: true},
        senderChat: {id: GROUP},
    });

    assert.equal(await passes(guard, ctx), false);
});

test("команда раздачи прав без автора (пост канала) не проходит", async () => {
    const guard = createAccessGuard(rights, silentLogger);

    assert.equal(await passes(guard, commandContext("/roles", GROUP)), false);
});

test("кнопку правки проверяют по нажавшему, а не по чату", async () => {
    //Карточку в группе видят все участники, а менять по ней может только тот, кому выдано лично.
    const checker = checkerById({
        [GROUP]: ["ROLE_SERVER_MANAGE"],
        [ROOT]: ["ROLE_SERVER_MANAGE"],
    });
    const guard = createAccessGuard(checker, silentLogger);
    const press = (userId: number) => ({
        ...callbackContext("a:x:14:c:0:", GROUP),
        from: {id: userId, is_bot: false},
    }) as unknown as Context;

    assert.equal(await passes(guard, press(ROOT)), true);
    assert.equal(await passes(guard, press(VASYA)), false, "права группы для правки не в счёт");
});

test("кнопку просмотра проверяют по чату", async () => {
    const guard = createAccessGuard(checkerById({[GROUP]: ["ROLE_SERVER_ADMIN_VIEW"]}), silentLogger);
    const ctx = {...callbackContext("a:o:14:c:0:", GROUP), from: {id: VASYA, is_bot: false}} as unknown as Context;

    assert.equal(await passes(guard, ctx), true);
});
