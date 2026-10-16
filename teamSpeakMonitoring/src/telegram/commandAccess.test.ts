import test from "node:test";
import assert from "node:assert/strict";
import type {Composer, Context} from "grammy";
import {CALLBACK_ACCESS, COMMAND_ACCESS, accessSubject, callbackPermission, commandPermission} from "./commandAccess.js";
import {PERMISSIONS} from "../access/Roles.js";
import type {BotCommands} from "./TelegramBot.js";
import {AccessCommands, type AccessManager, type ChatMenus, type ChatRegistry} from "./AccessCommands.js";
import {TeamSpeakCommands, type OnlineNicknamesSource} from "./TeamSpeakCommands.js";
import {PlayerCommands, type PlayerSubscriptionStore} from "./PlayerCommands.js";
import {
    SubscriptionCommands,
    type ServerCatalog,
    type StatusSource,
    type SubscriptionStore,
} from "./SubscriptionCommands.js";
import type {PlayerObserver} from "../players/PlayerObserver.js";
import {ServerAdminCommands, type AdminServerChecker, type ServerAdministration} from "./ServerAdminCommands.js";
import {encodePlayerCard, encodePlayerHistory, encodePlayerInfo, encodePlayerPick, encodePlayerWait} from "./PlayerMessages.js";
import {silentLogger} from "../test/silentLogger.js";

//Карта прав обязана совпадать с тем, что наборы реально слушают. Расхождение в одну сторону —
//команда, которую страж никому не пропустит (не работает вовсе). В другую — право в карте
//без команды: мёртвая строка, которая врёт администратору в /roles.
//
//Наборы собираются настоящие, с заглушками зависимостей: регистрация обработчиков в них
//от зависимостей не зависит.

interface Registered {
    commands: string[];
    callbackTriggers: (string | RegExp)[];
    //Всё, что повешено мимо command/callbackQuery: такой обработчик страж не умеет сопоставить
    //с правом, значит, он либо недостижим, либо открыт. И то и другое — ошибка.
    other: string[];
}

function allCommandSets(): BotCommands[] {
    return [
        new AccessCommands(
            {} as unknown as AccessManager,
            {} as unknown as ChatRegistry,
            {} as unknown as ChatMenus,
            silentLogger,
        ),
        new TeamSpeakCommands({} as unknown as OnlineNicknamesSource),
        new PlayerCommands(
            {} as unknown as PlayerObserver,
            {} as unknown as PlayerSubscriptionStore,
            {} as unknown as ChatRegistry,
            {pendingTtlMs: 1_000, pendingLimit: 5},
            silentLogger,
            () => new Date(),
        ),
        new SubscriptionCommands(
            {} as unknown as ServerCatalog,
            {} as unknown as SubscriptionStore,
            {} as unknown as StatusSource,
            () => undefined,
        ),
        new ServerAdminCommands(
            {} as unknown as ServerAdministration,
            {} as unknown as AdminServerChecker,
            silentLogger,
        ),
    ];
}

function registerAll(): Registered {
    const registered: Registered = {commands: [], callbackTriggers: [], other: []};
    const record = (name: string) => (): void => {
        registered.other.push(name);
    };

    const composer = {
        command: (name: string | string[]): void => {
            registered.commands.push(...(Array.isArray(name) ? name : [name]));
        },
        callbackQuery: (trigger: string | RegExp): void => {
            registered.callbackTriggers.push(trigger);
        },
        on: record("on"),
        use: record("use"),
        hears: record("hears"),
        filter: record("filter"),
        drop: record("drop"),
        inlineQuery: record("inlineQuery"),
        chatType: record("chatType"),
    } as unknown as Composer<Context>;

    for (const set of allCommandSets()) {
        set.register(composer);
    }

    return registered;
}

test("у каждой зарегистрированной команды есть право в карте", () => {
    const {commands} = registerAll();

    for (const command of commands) {
        assert.ok(commandPermission(command), `команда /${command} не описана в COMMAND_ACCESS — страж её не пропустит`);
    }
});

test("в карте нет команд, которых никто не регистрирует", () => {
    const registered = new Set(registerAll().commands);

    for (const command of Object.keys(COMMAND_ACCESS)) {
        assert.ok(registered.has(command), `в COMMAND_ACCESS есть /${command}, но такой команды нет`);
    }
});

test("у каждой кнопки есть право, и в карте нет лишних кнопок", () => {
    const {callbackTriggers} = registerAll();
    const mapped = CALLBACK_ACCESS.map(rule => rule.match);

    //Сравнение по самим шаблонам, а не по примерам данных: шаблон один на отрисовку,
    //регистрацию и карту, поэтому совпадать он обязан тождественно.
    for (const trigger of callbackTriggers) {
        assert.ok(mapped.includes(trigger), `кнопка ${String(trigger)} не описана в CALLBACK_ACCESS`);
    }

    for (const match of mapped) {
        assert.ok(callbackTriggers.includes(match), `в CALLBACK_ACCESS есть ${String(match)}, но обработчика нет`);
    }
});

test("наборы не вешают обработчиков мимо карты", () => {
    assert.deepEqual(registerAll().other, []);
});

test("каждая команда меню есть в карте", () => {
    //Пункт меню без права не покажется никому — и это тоже ошибка, только тихая.
    for (const set of allCommandSets()) {
        for (const item of set.describe()) {
            assert.ok(commandPermission(item.command), `пункт меню /${item.command} без права`);
        }
    }
});

test("каждое право что-то разрешает", () => {
    const used = new Set([
        ...Object.values(COMMAND_ACCESS),
        ...CALLBACK_ACCESS.map(rule => rule.permission),
    ]);

    for (const permission of PERMISSIONS) {
        assert.ok(used.has(permission), `право ${permission} не открывает ни одной команды`);
    }
});

test("кнопки игроков требуют прав своей команды", () => {
    //Запрет команды не должен обходиться нажатием кнопки из старого сообщения.
    const wait = encodePlayerWait("Добрый Фей");

    assert.ok(wait);
    assert.equal(callbackPermission(encodePlayerPick(7)), "ROLE_PLAYER_WATCH");
    assert.equal(callbackPermission(wait), "ROLE_PLAYER_WATCH");
    assert.equal(callbackPermission(encodePlayerCard(7)), "ROLE_PLAYER_WHERE");
    assert.equal(callbackPermission(encodePlayerHistory(7)), "ROLE_PLAYER_HISTORY");
    assert.equal(callbackPermission(encodePlayerInfo(7)), "ROLE_PLAYER_DOSSIER");
});

test("незнакомая кнопка и незнакомая команда не получают права", () => {
    assert.equal(callbackPermission("zz:1"), undefined);
    assert.equal(commandPermission("constructor"), undefined, "прототип объекта картой не считается");
    assert.equal(commandPermission("debug"), undefined);
});

test("правка проверяется по человеку, просмотр и обычные команды — по чату", () => {
    //Правило «видеть — по чату, менять — по человеку». До итерации 14 «по человеку» была только
    //раздача прав; с управлением серверами к ней добавилась правка списка серверов.
    //Иначе root не смог бы раздавать права и править серверы в группе, а группа с такими правами
    //давала бы их каждому участнику.
    const personal = new Set(["ROLE_ACCESS_MANAGE", "ROLE_SERVER_MANAGE"]);

    for (const [command, permission] of Object.entries(COMMAND_ACCESS)) {
        assert.equal(accessSubject(permission), personal.has(permission) ? "user" : "chat", `/${command}`);
    }

    assert.equal(accessSubject(COMMAND_ACCESS["grant"] ?? "ROLE_ANONYMOUS"), "user");
    assert.equal(accessSubject(COMMAND_ACCESS["server_edit"] ?? "ROLE_ANONYMOUS"), "user");
    assert.equal(accessSubject(COMMAND_ACCESS["server"] ?? "ROLE_ANONYMOUS"), "chat", "просмотр карточки — по чату");
    assert.equal(accessSubject(COMMAND_ACCESS["watch"] ?? "ROLE_ANONYMOUS"), "chat");
});
