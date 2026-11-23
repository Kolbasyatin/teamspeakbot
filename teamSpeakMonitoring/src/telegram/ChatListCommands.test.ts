import test from "node:test";
import assert from "node:assert/strict";
import type {Composer, Context} from "grammy";
import {ChatListCommands, parseChatId, type ChatDirectory, type ChatHistorySource} from "./ChatListCommands.js";
import {CHAT_LIST_PAGE_SIZE, CHAT_LIST_PATTERN, type ChatListEntry} from "./ChatListMessage.js";
import {CHAT_HISTORY_PAGE_SIZE, CHAT_HISTORY_PATTERN, type ChatHistoryEntry} from "./ChatHistoryMessage.js";
import {silentLogger} from "../test/silentLogger.js";

type Handler = (ctx: Context) => Promise<void>;

//Набор, зарегистрированный на поддельном Composer: обработчик команды и кнопок по их шаблонам.
function handlers(directory: ChatDirectory, history: ChatHistorySource = emptyHistory()): {
    command: Handler;
    listPage: Handler;
    historyPage: Handler;
} {
    let command: Handler | undefined;
    const callbacks = new Map<RegExp, Handler>();

    new ChatListCommands(directory, history, {isRoot: () => false}, silentLogger).register({
        command: (_name: string, handler: Handler) => {
            command = handler;
        },
        callbackQuery: (trigger: RegExp, handler: Handler) => {
            callbacks.set(trigger, handler);
        },
    } as unknown as Composer<Context>);

    const listPage = callbacks.get(CHAT_LIST_PATTERN);
    const historyPage = callbacks.get(CHAT_HISTORY_PATTERN);
    assert.ok(command && listPage && historyPage);
    return {command, listPage, historyPage};
}

function directoryOf(total: number, chat?: ChatListEntry): ChatDirectory & {asked: {limit: number; offset: number}[]} {
    const asked: {limit: number; offset: number}[] = [];

    return {
        asked,
        countChats: async () => ({total, private: total}),
        findChatPage: async (limit, offset): Promise<ChatListEntry[]> => {
            asked.push({limit, offset});
            return [];
        },
        findChat: async () => chat,
    };
}

function emptyHistory(): ChatHistorySource {
    return {countHistory: async () => 0, findHistoryPage: async () => []};
}

function commandCtx(match: string, replies: string[]): Context {
    return {
        match,
        reply: async (text: string) => {
            replies.push(text);
        },
    } as unknown as Context;
}

test("/chats показывает первую страницу", async () => {
    const directory = directoryOf(3);
    const replies: string[] = [];

    await handlers(directory).command(commandCtx("", replies));

    assert.deepEqual(directory.asked, [{limit: CHAT_LIST_PAGE_SIZE, offset: 0}]);
    assert.match(replies[0] ?? "", /Чаты, писавшие боту: 3/);
});

test("кнопка за последней страницей (чаты удалили, пока список был открыт) показывает последнюю", async () => {
    const directory = directoryOf(CHAT_LIST_PAGE_SIZE + 1);
    const edits: string[] = [];
    let answered = false;

    await handlers(directory).listPage({
        callbackQuery: {data: "ch:9"},
        answerCallbackQuery: async () => {
            answered = true;
        },
        editMessageText: async (text: string) => {
            edits.push(text);
        },
    } as unknown as Context);

    assert.ok(answered, "нажатие подтверждено — иначе у кнопки крутится индикатор");
    assert.deepEqual(directory.asked, [{limit: CHAT_LIST_PAGE_SIZE, offset: CHAT_LIST_PAGE_SIZE}]);
    assert.match(edits[0] ?? "", /Страница 2 из 2/);
});

test("/chats <chat_id> показывает историю этого чата, а не список", async () => {
    const chat: ChatListEntry = {
        chatId: -1003738458034, type: "supergroup", title: "Arma", firstSeenAt: new Date("2026-10-01T00:00:00Z"),
        roles: ["ROLE_SERVER_USER"], serverSubscriptions: 1, lists: ["klan"], blocked: false,
    };
    const asked: {chatId: number; limit: number; offset: number}[] = [];
    const entry: ChatHistoryEntry = {
        kind: "command", at: new Date("2026-11-24T12:00:00Z"), userId: 7, name: "who", arguments: undefined, known: true, allowed: false,
    };
    const replies: string[] = [];

    await handlers(directoryOf(1, chat), {
        countHistory: async () => 1,
        findHistoryPage: async (chatId, limit, offset) => {
            asked.push({chatId, limit, offset});
            return [entry];
        },
    }).command(commandCtx(" -1003738458034 ", replies));

    assert.deepEqual(asked, [{chatId: -1003738458034, limit: CHAT_HISTORY_PAGE_SIZE, offset: 0}]);
    assert.match(replies[0] ?? "", /👥 Arma — <code>-1003738458034<\/code>/);
    assert.match(replies[0] ?? "", /⛔ \/who — нет прав · от <code>7<\/code>/);
});

test("аргумент /chats — только целое число, иначе это список", () => {
    assert.equal(parseChatId(" 168350674 "), 168350674);
    assert.equal(parseChatId("-1003738458034"), -1003738458034);
    assert.equal(parseChatId(""), undefined);
    assert.equal(parseChatId("Arma"), undefined);
});
