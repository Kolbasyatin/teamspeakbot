import test from "node:test";
import assert from "node:assert/strict";
import type {Composer, Context} from "grammy";
import {ChatListCommands, type ChatDirectory} from "./ChatListCommands.js";
import {CHAT_LIST_PAGE_SIZE, type ChatListEntry} from "./ChatListMessage.js";
import {silentLogger} from "../test/silentLogger.js";

type Handler = (ctx: Context) => Promise<void>;

//Набор, зарегистрированный на поддельном Composer: достаём обработчики команды и кнопки.
function handlers(directory: ChatDirectory): {command: Handler; callback: Handler} {
    let command: Handler | undefined;
    let callback: Handler | undefined;

    new ChatListCommands(directory, {isRoot: () => false}, silentLogger).register({
        command: (_name: string, handler: Handler) => {
            command = handler;
        },
        callbackQuery: (_trigger: RegExp, handler: Handler) => {
            callback = handler;
        },
    } as unknown as Composer<Context>);

    assert.ok(command && callback);
    return {command, callback};
}

function directoryOf(total: number): ChatDirectory & {asked: {limit: number; offset: number}[]} {
    const asked: {limit: number; offset: number}[] = [];

    return {
        asked,
        countChats: async () => ({total, private: total}),
        findChatPage: async (limit, offset): Promise<ChatListEntry[]> => {
            asked.push({limit, offset});
            return [];
        },
    };
}

test("/chats показывает первую страницу", async () => {
    const directory = directoryOf(3);
    const replies: string[] = [];

    await handlers(directory).command({
        reply: async (text: string) => {
            replies.push(text);
        },
    } as unknown as Context);

    assert.deepEqual(directory.asked, [{limit: CHAT_LIST_PAGE_SIZE, offset: 0}]);
    assert.match(replies[0] ?? "", /Чаты, писавшие боту: 3/);
});

test("кнопка за последней страницей (чаты удалили, пока список был открыт) показывает последнюю", async () => {
    const directory = directoryOf(CHAT_LIST_PAGE_SIZE + 1);
    const edits: string[] = [];
    let answered = false;

    await handlers(directory).callback({
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
