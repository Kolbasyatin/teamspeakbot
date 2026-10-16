import test from "node:test";
import assert from "node:assert/strict";
import type {Bot, Context, Middleware, MiddlewareFn, Transformer} from "grammy";
import type {Logger} from "pino";
import {TelegramBot, type BotCommands} from "./TelegramBot.js";

const silentLogger = {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}} as unknown as Logger;
const passGuard: MiddlewareFn<Context> = async (_ctx, next) => next();

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
    ], passGuard, silentLogger, 60_000);

    assert.deepEqual(registered, ["status", "subscriptions"]);
});

test("пустой список наборов — не ошибка", () => {
    //Бот без команд остаётся рабочим: уведомления идут через sender и long polling им не нужен.
    const bot = new TelegramBot(createBotStub(), [], passGuard, silentLogger, 60_000);

    assert.ok(bot.sender);
});

test("меню собирается из всех наборов", () => {
    //Список меню не пишется отдельно — иначе команду легко зарегистрировать и забыть показать.
    const bot = new TelegramBot(createBotStub(), [
        createCommands("status", []),
        createCommands("subscriptions", []),
    ], passGuard, silentLogger, 60_000);

    assert.deepEqual(bot.describeMenu().map(item => item.command), ["status", "subscriptions"]);
});

test("обработчик ошибок вешается всегда", () => {
    //Без него ошибка в любом обработчике гасит long polling, и бот молча умирает
    //до перезапуска процесса.
    const stub = createBotStub();

    new TelegramBot(stub, [], passGuard, silentLogger, 60_000);

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

    new TelegramBot(bot, [], passGuard, silentLogger, 60_000);

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

test("наборы команд регистрируются за стражем, а не на самом боте", async () => {
    //Главное требование rbac.md: внутрь попадает только то, что страж пропустил. Проверяется
    //поведением: страж молчит — обработчик набора не вызывается.
    const used: Middleware<Context>[] = [];
    const bot = {
        api: {config: {use: (): void => undefined}},
        catch: (): void => undefined,
        use: (middleware: Middleware<Context>): void => {
            used.push(middleware);
        },
    } as unknown as Bot;
    let handled = false;
    const commands: BotCommands = {
        register: composer => {
            composer.use(() => {
                handled = true;
            });
        },
        describe: () => [],
    };
    const denyAll: MiddlewareFn<Context> = async () => undefined;

    new TelegramBot(bot, [commands], denyAll, silentLogger, 60_000);

    //Последний middleware бота — Composer со стражем и наборами.
    const last = used.at(-1);

    assert.ok(last);
    const guarded = typeof last === "function" ? last : last.middleware();

    await guarded({} as Context, async () => undefined);
    assert.equal(handled, false, "страж не пропустил — набор не должен был сработать");
});

test("меню чата строится по его правам", () => {
    const bot = new TelegramBot(createBotStub(), [{
        register: (): void => undefined,
        describe: () => [
            {command: "serverlist", description: "каталог"},
            {command: "watch", description: "следить"},
            //Команды нет в карте прав — не показывается никому, как страж её никому и не пропустит.
            {command: "unmapped", description: "забыли в карте"},
        ],
    }], passGuard, silentLogger, 60_000);

    assert.deepEqual(bot.menuFor(new Set(["ROLE_SERVER_LIST"])).map(item => item.command), ["serverlist"]);
    assert.deepEqual(
        bot.menuFor(new Set(["ROLE_SERVER_LIST", "ROLE_PLAYER_WATCH"])).map(item => item.command),
        ["serverlist", "watch"],
    );
});
