import test from "node:test";
import assert from "node:assert/strict";
import type {Composer, Context} from "grammy";
import {FeedbackCommands, type FeedbackStore, type NewFeedback, type NewFeedbackReply, type StoredFeedback} from "./FeedbackCommands.js";
import type {FeedbackThread} from "./FeedbackMessages.js";
import {FEEDBACK_LIMIT} from "./FeedbackMessages.js";
import {silentLogger} from "../test/silentLogger.js";

//Сценарии целиком, на хранилище в памяти и поддельной отправке: кому ушло, что сохранилось,
//что услышал автор. SQL проверяет FeedbackRepository.test.ts.

class MemoryFeedbackStore implements FeedbackStore {
    public readonly saved: (NewFeedback & {id: number})[] = [];
    public readonly deliveries: {feedbackId: number; adminChatId: number; adminMessageId: number}[] = [];
    public readonly replies: NewFeedbackReply[] = [];

    public async addReply(reply: NewFeedbackReply): Promise<void> {
        this.replies.push(reply);
    }

    public async countFeedback(): Promise<number> {
        return this.saved.length;
    }

    public async findFeedbackPage(limit: number, offset: number): Promise<FeedbackThread[]> {
        return [...this.saved].reverse().slice(offset, offset + limit).map(item => ({
            id: item.id,
            chatId: item.chatId,
            author: item.author,
            text: item.text,
            createdAt: new Date("2026-11-24T12:00:00Z"),
            replies: this.replies.filter(reply => reply.feedbackId === item.id).map(reply => ({
                text: reply.text,
                createdAt: new Date("2026-11-24T12:05:00Z"),
                delivered: reply.delivered,
                adminUserId: reply.adminUserId,
            })),
        }));
    }

    public async save(feedback: NewFeedback): Promise<number> {
        const id = this.saved.length + 1;

        this.saved.push({...feedback, id});

        return id;
    }

    public async countRecent(chatId: number): Promise<number> {
        return this.saved.filter(item => item.chatId === chatId).length;
    }

    public async addDelivery(feedbackId: number, adminChatId: number, adminMessageId: number): Promise<void> {
        this.deliveries.push({feedbackId, adminChatId, adminMessageId});
    }

    public async findByDelivery(adminChatId: number, adminMessageId: number): Promise<StoredFeedback | undefined> {
        const delivery = this.deliveries.find(item => item.adminChatId === adminChatId && item.adminMessageId === adminMessageId);
        const feedback = delivery && this.saved.find(item => item.id === delivery.feedbackId);

        return feedback && {id: feedback.id, chatId: feedback.chatId, text: feedback.text};
    }
}

const ROOT_A = 100;
const ROOT_B = 200;
const AUTHOR = 555;

function setup(recipients: number[], failFor: number[] = []) {
    const store = new MemoryFeedbackStore();
    const sent: {chatId: number; html: string}[] = [];
    const handlers = new Map<string, (ctx: Context) => Promise<void>>();
    let nextMessageId = 1_000;

    const commands = new FeedbackCommands(store, {saveChat: async () => undefined}, {
        send: async (chatId, html) => {
            if (failFor.includes(chatId)) {
                throw new Error("Forbidden: bot was blocked by the user");
            }

            sent.push({chatId, html});
            return nextMessageId++;
        },
    }, recipients, silentLogger);

    commands.register({
        command: (name: string, handler: (ctx: Context) => Promise<void>) => handlers.set(name, handler),
        callbackQuery: () => undefined,
    } as unknown as Composer<Context>);

    //Ответы бота в чат, где набрана команда.
    const replies: string[] = [];
    const run = async (command: string, chatId: number, match: string, replyTo?: number): Promise<void> => {
        await handlers.get(command)?.({
            match,
            chatId,
            chat: {id: chatId, type: "private", first_name: "Вася"},
            from: {id: chatId, is_bot: false, first_name: "Вася"},
            message: replyTo === undefined ? {} : {reply_to_message: {message_id: replyTo}},
            reply: async (text: string) => {
                replies.push(text);
            },
        } as unknown as Context);
    };

    return {store, sent, replies, run};
}

test("сообщение доставляется каждому получателю и сохраняется", async () => {
    const {store, sent, replies, run} = setup([ROOT_A, ROOT_B]);

    await run("message", AUTHOR, "Добавьте EXD #3");

    assert.deepEqual(sent.map(item => item.chatId), [ROOT_A, ROOT_B]);
    assert.match(sent[0]?.html ?? "", /Добавьте EXD #3/);
    assert.equal(store.saved[0]?.text, "Добавьте EXD #3");
    assert.equal(store.deliveries.length, 2);
    assert.deepEqual(replies, ["Спасибо, передал администратору."]);
});

test("отказ одному получателю не мешает остальным", async () => {
    const {sent, store, replies, run} = setup([ROOT_A, ROOT_B], [ROOT_A]);

    await run("message", AUTHOR, "привет");

    assert.deepEqual(sent.map(item => item.chatId), [ROOT_B]);
    assert.equal(store.deliveries.length, 1);
    assert.deepEqual(replies, ["Спасибо, передал администратору."]);
});

test("некому доставить — сообщение всё равно сохраняется, и автору сказано честно", async () => {
    const {store, sent, replies, run} = setup([]);

    await run("message", AUTHOR, "привет");

    assert.equal(store.saved.length, 1);
    assert.equal(sent.length, 0);
    assert.deepEqual(replies, ["Спасибо, сообщение сохранено."]);
});

test("слишком частые сообщения не сохраняются и не доставляются", async () => {
    const {store, sent, replies, run} = setup([ROOT_A]);

    for (let index = 0; index <= FEEDBACK_LIMIT; index++) {
        await run("message", AUTHOR, `сообщение ${index}`);
    }

    assert.equal(store.saved.length, FEEDBACK_LIMIT);
    assert.equal(sent.length, FEEDBACK_LIMIT);
    assert.match(replies.at(-1) ?? "", /Не больше/);
});

test("ответ ответом на доставленное уходит автору с цитатой", async () => {
    const {sent, replies, run} = setup([ROOT_A]);

    await run("message", AUTHOR, "Добавьте EXD #3");

    const deliveredId = 1_000;

    await run("reply", ROOT_A, "Добавили, смотрите /serverlist", deliveredId);

    const answer = sent.at(-1);

    assert.equal(answer?.chatId, AUTHOR);
    assert.match(answer?.html ?? "", /«Добавьте EXD #3»/);
    assert.match(answer?.html ?? "", /Добавили, смотрите \/serverlist/);
    assert.equal(replies.at(-1), "Ответ на #1 отправлен.");
});

test("ответ сохраняется вместе с обращением: кто, откуда, текст, дошёл ли", async () => {
    const {store, run} = setup([ROOT_A]);

    await run("message", AUTHOR, "Добавьте EXD #3");
    await run("reply", ROOT_A, "Добавили", 1_000);

    assert.deepEqual(store.replies, [{feedbackId: 1, adminChatId: ROOT_A, adminUserId: ROOT_A, text: "Добавили", delivered: true}]);
});

test("ответить можно только из того чата, куда доставлено", async () => {
    //Тот же id сообщения в другом чате — это другое сообщение. Иначе /reply открывал бы переписку
    //с любым автором тому, кто угадал номер.
    const {sent, replies, run} = setup([ROOT_A]);

    await run("message", AUTHOR, "привет");
    await run("reply", 999, "чужой ответ", 1_000);

    assert.equal(sent.length, 1, "ответ не ушёл");
    assert.match(replies.at(-1) ?? "", /не сообщение обратной связи/);
});

test("/reply без ответа на сообщение и без текста — подсказка", async () => {
    const {run, replies} = setup([ROOT_A]);

    await run("message", AUTHOR, "привет");
    await run("reply", ROOT_A, "текст");
    assert.match(replies.at(-1) ?? "", /Ответьте этой командой/);

    await run("reply", ROOT_A, " ", 1_000);
    assert.match(replies.at(-1) ?? "", /текст ответа/);
});

test("автор заблокировал бота — администратору сказано, что ответ не дошёл", async () => {
    const {replies, run} = setup([ROOT_A], [AUTHOR]);

    await run("message", AUTHOR, "привет");
    await run("reply", ROOT_A, "ответ", 1_000);

    assert.match(replies.at(-1) ?? "", /Не доставлено/);
});

test("недоставленный ответ тоже сохраняется — попытка ответить часть переписки", async () => {
    const {store, run} = setup([ROOT_A], [AUTHOR]);

    await run("message", AUTHOR, "привет");
    await run("reply", ROOT_A, "ответ", 1_000);

    assert.deepEqual(store.replies.map(reply => reply.delivered), [false]);
});

test("/feedback показывает обращения с ответами, новые сверху", async () => {
    const {run, replies} = setup([ROOT_A]);

    await run("message", AUTHOR, "первое");
    await run("message", AUTHOR, "второе");
    await run("reply", ROOT_A, "на первое", 1_000);
    await run("feedback", ROOT_A, "");

    const text = replies.at(-1) ?? "";
    assert.match(text, /Обратная связь: 2/);
    assert.ok(text.indexOf("второе") < text.indexOf("первое"), "новые сверху");
    assert.match(text, /💬 .*: на первое/);
    assert.match(text, /без ответа/);
});

test("страница /feedback с длинными обращениями и ответами влезает в сообщение Telegram", async () => {
    const {renderFeedbackList} = await import("./FeedbackMessages.js");
    const long = "<&>".repeat(700);
    const threads = Array.from({length: 10}, (_, index) => ({
        id: index + 1, chatId: 555, author: "Вася", text: long, createdAt: new Date(0),
        replies: Array.from({length: 5}, () => ({text: long, createdAt: new Date(0), delivered: true, adminUserId: 1})),
    }));

    assert.ok(renderFeedbackList(threads, 10, 0).text.length <= 4096);
});
