import test from "node:test";
import assert from "node:assert/strict";
import type {Bot} from "grammy";
import {TelegramBot, type BotCommands} from "./TelegramBot.js";

//Настоящий Bot здесь не нужен: проверяется только то, что владелец раздаёт его всем наборам
//и вешает обработчик ошибок. Сеть, long polling и api не участвуют.
function createBotStub(): Bot & {caught: boolean} {
    const stub = {
        caught: false,
        catch: (): void => {
            stub.caught = true;
        },
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
    ]);

    assert.deepEqual(registered, ["status", "subscriptions"]);
});

test("пустой список наборов — не ошибка", () => {
    //Бот без команд остаётся рабочим: уведомления идут через sender и long polling им не нужен.
    const bot = new TelegramBot(createBotStub(), []);

    assert.ok(bot.sender);
});

test("меню собирается из всех наборов", () => {
    //Список меню не пишется отдельно — иначе команду легко зарегистрировать и забыть показать.
    const bot = new TelegramBot(createBotStub(), [
        createCommands("status", []),
        createCommands("subscriptions", []),
    ]);

    assert.deepEqual(bot.describeMenu().map(item => item.command), ["status", "subscriptions"]);
});

test("обработчик ошибок вешается всегда", () => {
    //Без него ошибка в любом обработчике гасит long polling, и бот молча умирает
    //до перезапуска процесса.
    const stub = createBotStub();

    new TelegramBot(stub, []);

    assert.equal(stub.caught, true);
});
