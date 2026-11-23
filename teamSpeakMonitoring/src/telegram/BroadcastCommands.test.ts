import test from "node:test";
import assert from "node:assert/strict";
import type {Composer, Context} from "grammy";
import {BroadcastCommands} from "./BroadcastCommands.js";
import {renderReport} from "./BroadcastMessages.js";
import type {
    BroadcastStore,
    BroadcastTarget,
    MailingListStore,
    MembershipChange,
    NewBroadcast,
    StoredBroadcast,
} from "../broadcasts/Broadcasts.js";
import {silentLogger} from "../test/silentLogger.js";

type Handler = (ctx: Context) => Promise<void>;

const ROOT = 100;

//Хранилище в памяти: рассылки и их статусы, адресаты — по заранее заданной таблице.
class MemoryBroadcasts {
    public readonly created: StoredBroadcast[] = [];

    constructor(private readonly recipients: Record<string, number[]>) {
    }

    public store(): BroadcastStore {
        return {
            createBroadcast: async (broadcast: NewBroadcast) => {
                const id = this.created.length + 1;
                this.created.push({...broadcast, id, status: "pending", recipients: 0, delivered: 0, blocked: 0, failed: 0, createdAt: new Date(0), finishedAt: undefined});
                return id;
            },
            findBroadcast: async (id: number) => this.created.find(item => item.id === id),
            startBroadcast: async (id: number) => this.transition(id, "sending"),
            cancelBroadcast: async (id: number) => this.transition(id, "cancelled"),
            resolveRecipients: async (target: BroadcastTarget) => this.recipients[JSON.stringify(target)] ?? [],
            findRecentBroadcasts: async () => this.created,
        } as unknown as BroadcastStore;
    }

    private transition(id: number, status: "sending" | "cancelled"): boolean {
        const broadcast = this.created.find(item => item.id === id);

        if (!broadcast || broadcast.status !== "pending") {
            return false;
        }

        broadcast.status = status;
        return true;
    }
}

function lists(known: string[]): MailingListStore & {included: string[]} {
    const included: string[] = [];
    const change = (chatIds: readonly number[]): MembershipChange => ({changed: [...chatIds], unchanged: [], unknown: []});

    return {
        included,
        listMembers: async (name: string) => known.includes(name) ? [] : undefined,
        includeChats: async (name: string, chatIds: readonly number[]) => {
            included.push(`${name}:${chatIds.join(",")}`);
            return known.includes(name) ? change(chatIds) : undefined;
        },
        excludeChats: async (name: string, chatIds: readonly number[]) => known.includes(name) ? change(chatIds) : undefined,
    } as unknown as MailingListStore & {included: string[]};
}

function setup(recipients: Record<string, number[]> = {}, knownLists: string[] = ["klan"]) {
    const broadcasts = new MemoryBroadcasts(recipients);
    const mailing = lists(knownLists);
    const launched: number[] = [];
    const commands = new Map<string, Handler>();
    let decide: Handler | undefined;

    new BroadcastCommands(broadcasts.store(), mailing, {
        run: async broadcast => {
            launched.push(broadcast.id);
        },
    }, silentLogger).register({
        command: (name: string, handler: Handler) => commands.set(name, handler),
        callbackQuery: (_trigger: RegExp, handler: Handler) => {
            decide = handler;
        },
    } as unknown as Composer<Context>);

    const replies: {text: string; keyboard: unknown}[] = [];
    const run = async (command: string, match: string, reply?: object): Promise<void> => {
        await commands.get(command)?.({
            match,
            chatId: ROOT,
            from: {id: ROOT, is_bot: false},
            message: reply ? {reply_to_message: reply} : {},
            reply: async (text: string, options?: {reply_markup?: unknown}) => {
                replies.push({text, keyboard: options?.reply_markup});
            },
        } as unknown as Context);
    };
    const press = async (data: string, userId = ROOT): Promise<{answers: string[]; edits: string[]}> => {
        const answers: string[] = [];
        const edits: string[] = [];
        await decide?.({
            callbackQuery: {data},
            from: {id: userId, is_bot: false},
            answerCallbackQuery: async (text?: string) => {
                answers.push(text ?? "");
            },
            editMessageText: async (text: string) => {
                edits.push(text);
            },
        } as unknown as Context);
        return {answers, edits};
    };

    return {broadcasts, mailing, launched, replies, run, press};
}

const KLAN = JSON.stringify({kind: "list", name: "klan"});

test("/send ответом на сообщение — копия сообщения и вопрос «отправить N чатам?»", async () => {
    const {broadcasts, replies, run} = setup({[KLAN]: [1, 2, 3]});

    await run("send", "klan", {message_id: 77, text: "Вечером турнир"});

    assert.deepEqual(broadcasts.created[0]?.content, {kind: "copy", fromChatId: ROOT, messageId: 77});
    assert.match(replies[0]?.text ?? "", /Рассылка #1<\/b> → список <b>klan<\/b>: 3 чата/);
    assert.match(replies[0]?.text ?? "", /Вечером турнир/);
    assert.ok(replies[0]?.keyboard, "кнопки подтверждения");
});

test("/send текстом — простой текст; без текста и без ответа — подсказка", async () => {
    const {broadcasts, replies, run} = setup({[JSON.stringify({kind: "all"})]: [1]});

    await run("send", "all Сервер обновлён");
    assert.deepEqual(broadcasts.created[0]?.content, {kind: "text", text: "Сервер обновлён"});

    await run("send", "all");
    assert.match(replies.at(-1)?.text ?? "", /Как отправить/);
});

test("несуществующий список и пустая аудитория — рассылка не готовится", async () => {
    const {broadcasts, replies, run} = setup({}, ["klan"]);

    await run("send", "nosuch Привет");
    assert.match(replies.at(-1)?.text ?? "", /Списка «nosuch» нет/);

    await run("send", "klan Привет");
    assert.match(replies.at(-1)?.text ?? "", /Некому отправлять/);
    assert.equal(broadcasts.created.length, 0);
});

test("подтверждает только автор, и только один раз: двойное нажатие не запускает рассылку дважды", async () => {
    const {launched, run, press} = setup({[KLAN]: [1]});

    await run("send", "klan Привет");

    assert.deepEqual((await press("bc:y:1", 999)).answers, ["Подтверждает автор рассылки"]);
    assert.deepEqual(launched, []);

    const first = await press("bc:y:1");
    assert.deepEqual(first.answers, ["Отправляю"]);
    assert.match(first.edits[0] ?? "", /отправляю/);

    assert.deepEqual((await press("bc:y:1")).answers, ["Уже запущена или отменена"]);
    assert.deepEqual(launched, [1]);
});

test("отмена: рассылка не уходит и запустить её потом нельзя", async () => {
    const {launched, run, press} = setup({[KLAN]: [1]});

    await run("send", "klan Привет");

    assert.match((await press("bc:n:1")).edits[0] ?? "", /отменена/);
    assert.deepEqual((await press("bc:y:1")).answers, ["Уже запущена или отменена"]);
    assert.deepEqual(launched, []);
});

test("/list_include — по chat_id или ответом на сообщение человека; неизвестный список назван", async () => {
    const {mailing, replies, run} = setup();

    await run("list_include", "klan 555 -100");
    await run("list_include", "klan", {message_id: 1, from: {id: 777, is_bot: false}});
    await run("list_include", "nosuch 555");

    assert.deepEqual(mailing.included, ["klan:555,-100", "klan:777", "nosuch:555"]);
    assert.match(replies.at(-1)?.text ?? "", /Списка «nosuch» нет/);
});

test("отчёт автору: доставлено, недоступные и ошибки названы отдельно", () => {
    const broadcast = {id: 5, target: {kind: "all"}} as StoredBroadcast;

    const text = renderReport(broadcast, {recipients: 37, delivered: 34, blocked: 2, failed: 1});

    assert.match(text, /Рассылка #5<\/b> → все чаты: готово/);
    assert.match(text, /Доставлено 34 из 37/);
    assert.match(text, /Недоступны насовсем.*: 2/);
    assert.match(text, /Ошибок: 1/);
});
