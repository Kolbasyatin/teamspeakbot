import test from "node:test";
import assert from "node:assert/strict";
import type {Composer, Context} from "grammy";
import {
    SubscriptionCommands,
    type AdminCatalog,
    type ServerCatalog,
    type StatusSource,
    type SubscriptionStore,
} from "./SubscriptionCommands.js";

//Проверяется только выбор каталога в /serverlist: обычный — подписчику, полный — администратору.
//Остальное поведение набора покрыто тестами его сообщений (ServerListMessage, ServerCardMessage).

const publicCatalog: ServerCatalog = {
    findCatalogPage: async () => [{id: 1, name: "Готов", gameAddress: "a:1"}],
    countCatalog: async () => 1,
    findByIds: async () => [],
};

const store = {
    saveChat: async () => undefined,
    findSubscribedServerIds: async () => [],
} as unknown as SubscriptionStore;

function adminCatalog(allowed: boolean): AdminCatalog {
    return {
        canSeeAll: async () => allowed,
        page: async () => ({
            servers: [{id: 1, name: "Готов", gameAddress: "a:1"}, {id: 2, name: "Черновик", gameAddress: "b:2"}],
            total: 2,
            marks: new Map([[1, "🟢"], [2, "📝"]]),
        }),
        openButton: serverId => `admin-open:${serverId}`,
    };
}

async function serverlistButtons(catalog: AdminCatalog | undefined): Promise<string[]> {
    const handlers = new Map<string, (ctx: Context) => Promise<void>>();
    const composer = {
        command: (name: string | string[], handler: (ctx: Context) => Promise<void>): void => {
            for (const item of Array.isArray(name) ? name : [name]) {
                handlers.set(item, handler);
            }
        },
        callbackQuery: (): void => undefined,
    } as unknown as Composer<Context>;

    new SubscriptionCommands(publicCatalog, store, {} as StatusSource, () => undefined, catalog).register(composer);

    const labels: string[] = [];
    const ctx = {
        match: "",
        chatId: 42,
        chat: {id: 42, type: "private", first_name: "admin"},
        reply: async (_text: string, options: {reply_markup: {inline_keyboard: {text: string}[][]}}) => {
            labels.push(...options.reply_markup.inline_keyboard.flat().map(button => button.text));
        },
    } as unknown as Context;

    await handlers.get("serverlist")?.(ctx);

    return labels;
}

test("подписчик видит только готовые серверы каталога", async () => {
    assert.deepEqual(await serverlistButtons(adminCatalog(false)), ["▫️ Готов"]);
    assert.deepEqual(await serverlistButtons(undefined), ["▫️ Готов"], "без админки — обычный каталог");
});

test("администратор видит в той же команде все серверы с #id и значком", async () => {
    assert.deepEqual(await serverlistButtons(adminCatalog(true)), ["🟢 #1 Готов", "📝 #2 Черновик"]);
});
