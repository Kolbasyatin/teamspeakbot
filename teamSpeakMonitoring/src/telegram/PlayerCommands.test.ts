import test from "node:test";
import assert from "node:assert/strict";
import type {Bot} from "grammy";
import {PlayerCommands, type ChatRegistry, type PlayerSubscriptionStore} from "./PlayerCommands.js";
import {encodePlayerInfo, encodePlayerPick, encodePlayerWait} from "./PlayerMessages.js";
import type {PlayerObserver} from "../players/PlayerObserver.js";
import {silentLogger} from "../test/silentLogger.js";

//Проверяется СТРУКТУРА регистрации, а не поведение команд: что нарисованная кнопка попадёт
//в свой обработчик и что меню не расходится с тем, что бот на самом деле слушает.
//
//Это не теоретическая аккуратность. Кнопка «Ждать ник» один раз уже уехала в прод без обработчика:
//рисовалась она в PlayerMessages, а регистрация в PlayerCommands потерялась. Компилятор промолчал —
//ничего не ломается, — а человек получал «кнопка устарела» от общего перехватчика чужого набора.

interface Registered {
    commands: string[];
    callbackTriggers: (string | RegExp)[];
}

function registerOn(): Registered {
    const registered: Registered = {commands: [], callbackTriggers: []};

    const bot = {
        command: (name: string | string[]): void => {
            registered.commands.push(...(Array.isArray(name) ? name : [name]));
        },
        callbackQuery: (trigger: string | RegExp): void => {
            registered.callbackTriggers.push(trigger);
        },
    } as unknown as Bot;

    const commands = new PlayerCommands(
        {} as unknown as PlayerObserver,
        {} as unknown as PlayerSubscriptionStore,
        {} as unknown as ChatRegistry,
        {pendingTtlMs: 1_000, pendingLimit: 5},
        silentLogger,
        () => new Date(),
    );

    commands.register(bot);

    return registered;
}

//Совпадает ли строка кнопки хоть с одним зарегистрированным условием. Логика та же, что у grammy:
//строка сравнивается целиком, регулярка ищется частично (txt.match(trigger)).
function handled(triggers: readonly (string | RegExp)[], data: string): boolean {
    return triggers.some(trigger => typeof trigger === "string" ? trigger === data : data.match(trigger) !== null);
}

test("у каждой кнопки есть обработчик", () => {
    const {callbackTriggers} = registerOn();

    assert.ok(handled(callbackTriggers, encodePlayerPick(4812)), "выбор игрока из результатов поиска");

    const wait = encodePlayerWait("Добрый Фей");

    assert.ok(wait);
    assert.ok(handled(callbackTriggers, wait), "ожидание ненайденного игрока");
    assert.ok(handled(callbackTriggers, encodePlayerInfo(4812)), "досье игрока");
});

test("меню и реально зарегистрированные команды совпадают", () => {
    //Команда в меню без обработчика — бот молчит в ответ на подсказку, которую сам же показал.
    //Обработчик без меню — команда есть, но о ней никто не узнает.
    const {commands} = registerOn();
    const menu = new PlayerCommands(
        {} as unknown as PlayerObserver,
        {} as unknown as PlayerSubscriptionStore,
        {} as unknown as ChatRegistry,
        {pendingTtlMs: 1_000, pendingLimit: 5},
        silentLogger,
        () => new Date(),
    ).describe().map(item => item.command);

    assert.deepEqual([...commands].sort(), [...menu].sort());
});

test("чужие кнопки этим набором не перехватываются", () => {
    //Иначе набор про игроков съедал бы нажатия списка серверов и карточки: он регистрируется раньше.
    const {callbackTriggers} = registerOn();

    for (const foreign of ["s:r", "c:p:0::", "m:o:42::", "k:s:42:c:0:"]) {
        assert.ok(!handled(callbackTriggers, foreign), `не должен ловить ${foreign}`);
    }
});
