import test from "node:test";
import assert from "node:assert/strict";
import type {Bot, Transformer} from "grammy";
import type {Logger} from "pino";
import {TelegramBot, type BotCommands} from "./TelegramBot.js";

const silentLogger = {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}} as unknown as Logger;

//Настоящий Bot здесь не нужен: проверяется только то, что владелец раздаёт его всем наборам
//и вешает обработчик ошибок. Сеть, long polling и api не участвуют.
function createBotStub(): Bot & {caught: boolean} {
    const stub = {
        caught: false,
        catch: (): void => {
            stub.caught = true;
        },
        //Конструктор ставит трансформеры (диагностика, выключение превью ссылок) и middleware
        //диагностики, поэтому заглушке нужны api.config и use.
        api: {config: {use: (): void => undefined}},
        use: (): void => undefined,
    };

    return stub as unknown as Bot & {caught: boolean};
}

function createCommands(name: string, registeredOn: string[]): BotCommands {
    return {
        register: (): void => {
            registeredOn.push(name);
        },
        describe: () => [{command: name, description: `команды ${name}`}],
    };
}

test("каждому набору команд отдаётся бот", () => {
    //Забытый набор — это молча не работающая команда: ни ошибки, ни ответа пользователю.
    const registered: string[] = [];

    new TelegramBot(createBotStub(), [
        createCommands("status", registered),
        createCommands("subscriptions", registered),
    ], silentLogger, 60_000);

    assert.deepEqual(registered, ["status", "subscriptions"]);
});

test("пустой список наборов — не ошибка", () => {
    //Бот без команд остаётся рабочим: уведомления идут через sender и long polling им не нужен.
    const bot = new TelegramBot(createBotStub(), [], silentLogger, 60_000);

    assert.ok(bot.sender);
});

test("меню собирается из всех наборов", () => {
    //Список меню не пишется отдельно — иначе команду легко зарегистрировать и забыть показать.
    const bot = new TelegramBot(createBotStub(), [
        createCommands("status", []),
        createCommands("subscriptions", []),
    ], silentLogger, 60_000);

    assert.deepEqual(bot.describeMenu().map(item => item.command), ["status", "subscriptions"]);
});

test("обработчик ошибок вешается всегда", () => {
    //Без него ошибка в любом обработчике гасит long polling, и бот молча умирает
    //до перезапуска процесса.
    const stub = createBotStub();

    new TelegramBot(stub, [], silentLogger, 60_000);

    assert.equal(stub.caught, true);
});

test("превью ссылок выключено для всего исходящего", async () => {
    //Названия серверов содержат приглашения в discord: без этого каждое сообщение тащит
    //за собой карточку чужого сообщества.
    const calls: {method: string; payload: Record<string, unknown>}[] = [];
    const transformers: Transformer[] = [];
    const bot = {
        api: {
            config: {
                use: (transformer: Transformer): void => {
                    transformers.push(transformer);
                },
            },
        },
        catch: (): void => undefined,
        use: (): void => undefined,
    } as unknown as Bot;

    new TelegramBot(bot, [], silentLogger, 60_000);

    assert.equal(transformers.length, 2, "трансформеры должны ставиться в конструкторе");

    const prev = async (method: string, payload: Record<string, unknown>): Promise<never> => {
        calls.push({method, payload});
        return {ok: true, result: true} as never;
    };
    //Проверяется вся цепочка, а не трансформер по индексу: диагностика стоит в ней же и обязана
    //пропускать payload как есть.
    type ApiCall = Parameters<Transformer>[0];
    const transformer: Transformer = (base, method, payload, signal) => transformers
        .reduce<ApiCall>((inner, outer) => ((m, p, s) => outer(inner, m, p, s)) as ApiCall, base)(method, payload, signal);

    //sendMessage и editMessageText получают умолчание, остальные методы не трогаются.
    await transformer(prev as never, "sendMessage" as never, {chat_id: 1, text: "привет"} as never, undefined);
    await transformer(prev as never, "editMessageText" as never, {chat_id: 1, text: "правка"} as never, undefined);
    await transformer(prev as never, "answerCallbackQuery" as never, {callback_query_id: "x"} as never, undefined);

    assert.deepEqual(calls[0]?.payload["link_preview_options"], {is_disabled: true});
    assert.deepEqual(calls[1]?.payload["link_preview_options"], {is_disabled: true});
    assert.equal(calls[2]?.payload["link_preview_options"], undefined);

    //Вызов вправе включить превью себе обратно: умолчание стоит ДО payload.
    await transformer(
        prev as never,
        "sendMessage" as never,
        {chat_id: 1, text: "со ссылкой", link_preview_options: {is_disabled: false}} as never,
        undefined,
    );

    assert.deepEqual(calls[3]?.payload["link_preview_options"], {is_disabled: false});
});
