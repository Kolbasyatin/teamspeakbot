import test from "node:test";
import assert from "node:assert/strict";
import type {Context} from "grammy";
import {classifyUpdate, createAccessGuard, DENIED_TEXT, type AccessChecker} from "./AccessGuard.js";
import type {Permission} from "../access/Roles.js";
import {silentLogger} from "../test/silentLogger.js";

const ME = {username: "TsBot"};

function commandContext(text: string, chatId = 42): Context & {replies: string[]; answers: string[]} {
    const commandLength = text.split(/\s/)[0]?.length ?? 0;
    const replies: string[] = [];

    return {
        me: ME,
        chatId,
        message: {text, entities: [{type: "bot_command", offset: 0, length: commandLength}]},
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
