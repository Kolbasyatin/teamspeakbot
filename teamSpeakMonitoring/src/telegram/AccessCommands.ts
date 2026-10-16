import type {Composer, Context} from "grammy";
import type {BotCommand, Message} from "grammy/types";
import type {Logger} from "pino";
import type {AccessActor, AccessChange, RoleAssignment} from "../access/AccessControl.js";
import {
    DEFAULT_ROLE,
    PERMISSIONS,
    ROLE_GROUPS,
    ROLE_HIERARCHY,
    parseRole,
    type ManageRefusal,
    type Permission,
    type Role,
} from "../access/Roles.js";
import type {BotCommands} from "./TelegramBot.js";
import type {TelegramChat, TelegramChatType} from "./TelegramChat.js";
import {COMMAND_ACCESS} from "./commandAccess.js";

//Доступ глазами команд: всё, что им нужно от AccessControl, и ничего сверх того.
export interface AccessManager {
    isRoot(chatId: number): boolean;

    listRootChatIds(): readonly number[];

    rolesOf(chatId: number): Promise<readonly Role[]>;

    permissionsOf(chatId: number): Promise<ReadonlySet<Permission>>;

    listAssignments(): Promise<RoleAssignment[]>;

    grant(actor: AccessActor, targetChatId: number, role: Role, note: string | undefined): Promise<AccessChange>;

    revoke(actor: AccessActor, targetChatId: number, role: Role): Promise<AccessChange>;

    grantDefaultOnce(chatId: number): Promise<boolean>;
}

//Меню команд по правам. Реализует TelegramBot, но он собирается ПОСЛЕ наборов команд, поэтому
//в composition root сюда приходит объект с поздним связыванием — тем же приёмом, что chatSender.
export interface ChatMenus {
    menuFor(permissions: ReadonlySet<Permission>): BotCommand[];

    publishChatMenu(chatId: number, permissions: ReadonlySet<Permission>): Promise<void>;
}

export interface ChatRegistry {
    saveChat(chat: TelegramChat): Promise<void>;
}

const INTRO = "Слежу за игровыми серверами Arma Reforger и пишу, когда они падают и поднимаются.";

//Telegram режет сообщение на 4096 символах; запас — под хвост «…и ещё N».
const MESSAGE_BUDGET = 3_800;

const REFUSAL_TEXT: Record<ManageRefusal, string> = {
    rootOnlyFromConfig: "ROLE_ROOT выдаётся только через TELEGRAM_ROOT_CHAT_IDS — ни выдать, ни отнять его из бота нельзя.",
    implicit: "ROLE_ANONYMOUS есть у всех и так.",
    noAccessManage: "У вас нет права раздавать роли.",
    adminOnlyByRoot: "Роли с правом раздавать права выдаёт и отзывает только root.",
    exceedsOwn: "Выдать или отозвать можно только то, что есть у вас самих.",
};

const GRANT_USAGE = [
    "Как выдать роль:",
    "/grant <chat_id> <роль> [заметка] — по id из /whoami",
    "/grant <роль> ответом на сообщение человека — ему лично",
    "/grant <роль> в группе без ответа — всей группе",
    "",
    "Список ролей — /roles.",
].join("\n");

const REVOKE_USAGE = [
    "Как отозвать роль:",
    "/revoke <chat_id> <роль>",
    "/revoke <роль> ответом на сообщение человека или в группе без ответа",
].join("\n");

//Разобранные аргументы /grant и /revoke. Чистая функция, проверяется без grammy.
export interface RoleCommandArguments {
    targetChatId: number | undefined;
    rawRole: string | undefined;
    note: string | undefined;
}

export function parseRoleCommand(argument: string): RoleCommandArguments {
    const tokens = argument.trim().split(/\s+/).filter(token => token !== "");
    const first = tokens[0];
    const explicitTarget = first !== undefined && /^-?\d+$/.test(first) ? Number(first) : undefined;
    const rest = explicitTarget === undefined ? tokens : tokens.slice(1);
    const note = rest.slice(1).join(" ");

    return {
        targetChatId: explicitTarget !== undefined && Number.isSafeInteger(explicitTarget) ? explicitTarget : undefined,
        rawRole: rest[0],
        note: note === "" ? undefined : note,
    };
}

//Кому адресована выдача, если id не назван явно:
//  ответ на сообщение человека — ему лично (user_id равен chat_id его лички с ботом);
//  в группе без ответа — самой группе;
//  в личке без id — непонятно кому: себе выдавать бессмысленно, а угадывать нельзя.
//
//В супергруппе с темами каждое сообщение формально «отвечает» на служебное сообщение
//о создании темы. Такой ответ — не указание на человека, и он пропускается.
export function resolveTarget(
    explicit: number | undefined,
    chat: {id: number; type: string},
    reply: Message | undefined,
): number | undefined {
    if (explicit !== undefined) {
        return explicit;
    }

    if (reply && reply.forum_topic_created === undefined && reply.from && !reply.from.is_bot) {
        return reply.from.id;
    }

    return chat.type === "private" ? undefined : chat.id;
}

//Права чата и управление ими. Отдельный набор: /start, /help и /whoami доступны всем
//и рассказывают о боте по правам спросившего, а /grant, /revoke и /roles — команды администратора.
//Все они живут здесь, потому что зависят от одного и того же — от доступа.
export class AccessCommands implements BotCommands {
    public constructor(
        private readonly access: AccessManager,
        private readonly chats: ChatRegistry,
        private readonly menus: ChatMenus,
        private readonly logger: Logger,
    ) {
    }

    public describe(): BotCommand[] {
        return [
            {command: "start", description: "что умеет бот"},
            {command: "help", description: "доступные мне команды"},
            {command: "whoami", description: "мой chat_id и мои роли"},
            {command: "grant", description: "выдать роль"},
            {command: "revoke", description: "отозвать роль"},
            {command: "roles", description: "кому какие роли выданы"},
        ];
    }

    public register(bot: Composer<Context>): void {
        bot.command("start", ctx => this.start(ctx));
        bot.command("help", ctx => this.help(ctx));
        bot.command("whoami", ctx => this.whoami(ctx));
        bot.command("grant", ctx => this.grant(ctx, argumentOf(ctx)));
        bot.command("revoke", ctx => this.revoke(ctx, argumentOf(ctx)));
        bot.command("roles", ctx => this.roles(ctx));
    }

    //Публикует персональные меню чатам, чьи права отличаются от умолчания. На старте, потому что
    //состав ролей мог поменяться с выкатом, а меню Telegram хранит у себя.
    public async publishMenus(): Promise<void> {
        const chatIds = new Set<number>(this.access.listRootChatIds());

        for (const assignment of await this.access.listAssignments()) {
            if (assignment.role !== DEFAULT_ROLE) {
                chatIds.add(assignment.chatId);
            }
        }

        for (const chatId of chatIds) {
            await this.publishMenu(chatId);
        }
    }

    private async start(ctx: Context): Promise<void> {
        const chat = ctx.chat;

        if (!chat) {
            return;
        }

        //Чат обязан существовать в базе раньше роли: на него смотрит внешний ключ.
        await this.chats.saveChat(toTelegramChat(chat));

        if (await this.access.grantDefaultOnce(chat.id)) {
            await this.publishMenu(chat.id);
        }

        await ctx.reply([INTRO, "", await this.renderAvailable(chat.id)].join("\n"));
    }

    private async help(ctx: Context): Promise<void> {
        const chatId = ctx.chatId;

        if (chatId === undefined) {
            return;
        }

        await ctx.reply(await this.renderAvailable(chatId));
    }

    //Доступна всем: это способ сообщить администратору свой id. В группе показываются оба —
    //id группы (права группы) и id человека (его личные права, если выдать ответом на сообщение).
    private async whoami(ctx: Context): Promise<void> {
        const chat = ctx.chat;

        if (!chat) {
            return;
        }

        const roles = await this.access.rolesOf(chat.id);
        const lines = [`chat_id: ${chat.id} (${chat.type})`];

        if (chat.type !== "private" && ctx.from) {
            lines.push(`ваш user_id: ${ctx.from.id}`);
        }

        lines.push(roles.length === 0
            ? "Роли: нет"
            : `Роли: ${roles.map(role => role === "ROLE_ROOT" ? "ROLE_ROOT (из конфигурации)" : role).join(", ")}`);

        if (chat.type !== "private") {
            lines.push("", "Права группы действуют для всех её участников.");
        }

        await ctx.reply(lines.join("\n"));
    }

    private async grant(ctx: Context, argument: string): Promise<void> {
        const parsed = await this.parseTarget(ctx, argument, GRANT_USAGE);

        if (!parsed) {
            return;
        }

        const change = await this.access.grant(actorOf(ctx), parsed.targetChatId, parsed.role, parsed.note);

        if (change.result === "granted") {
            await this.publishMenu(parsed.targetChatId);
        }

        await ctx.reply(this.describeChange(change, parsed.targetChatId, parsed.role));
    }

    private async revoke(ctx: Context, argument: string): Promise<void> {
        const parsed = await this.parseTarget(ctx, argument, REVOKE_USAGE);

        if (!parsed) {
            return;
        }

        const change = await this.access.revoke(actorOf(ctx), parsed.targetChatId, parsed.role);

        if (change.result === "revoked") {
            await this.publishMenu(parsed.targetChatId);
        }

        await ctx.reply(this.describeChange(change, parsed.targetChatId, parsed.role));
    }

    //Кому что выдано и какие роли вообще есть. Роль по умолчанию есть почти у каждого чата,
    //поэтому она считается, а не перечисляется: иначе список рос бы с каждым /start
    //и упёрся бы в предел длины сообщения.
    private async roles(ctx: Context): Promise<void> {
        const assignments = await this.access.listAssignments();
        const byChat = new Map<number, RoleAssignment[]>();
        let defaultCount = 0;

        for (const assignment of assignments) {
            if (assignment.role === DEFAULT_ROLE) {
                defaultCount++;
                continue;
            }

            byChat.set(assignment.chatId, [...byChat.get(assignment.chatId) ?? [], assignment]);
        }

        const lines = [
            `Root (из конфигурации): ${this.access.listRootChatIds().join(", ") || "не задан"}`,
            `${DEFAULT_ROLE} (по умолчанию): ${defaultCount} чат(ов)`,
            "",
        ];

        if (byChat.size === 0) {
            lines.push("Других назначений нет.");
        } else {
            lines.push("Назначения:");

            for (const [chatId, chatAssignments] of byChat) {
                const title = chatAssignments[0]?.chatTitle;
                const roles = chatAssignments.map(describeAssignment).join("; ");

                lines.push(`• ${chatId}${title ? ` «${title}»` : ""} — ${roles}`);
            }
        }

        lines.push("", ...renderRoleCatalog());

        await ctx.reply(fitMessage(lines));
    }

    //Общее начало /grant и /revoke: разобрать роль и адресата, а на непонятном — подсказать.
    private async parseTarget(
        ctx: Context,
        argument: string,
        usage: string,
    ): Promise<{targetChatId: number; role: Role; note: string | undefined} | undefined> {
        const parsed = parseRoleCommand(argument);
        const chat = ctx.chat;

        if (!chat || parsed.rawRole === undefined) {
            await ctx.reply(usage);
            return undefined;
        }

        const role = parseRole(parsed.rawRole);

        if (role === undefined) {
            await ctx.reply(`Роли «${parsed.rawRole}» нет. Список ролей — /roles.`);
            return undefined;
        }

        const targetChatId = resolveTarget(parsed.targetChatId, chat, ctx.message?.reply_to_message);

        if (targetChatId === undefined) {
            await ctx.reply(usage);
            return undefined;
        }

        return {targetChatId, role, note: parsed.note};
    }

    private describeChange(change: AccessChange, targetChatId: number, role: Role): string {
        switch (change.result) {
            case "granted":
                return `Выдал ${role} чату ${targetChatId}.`;
            case "revoked":
                return `Отозвал ${role} у чата ${targetChatId}.`;
            case "alreadyGranted":
                return `У чата ${targetChatId} роль ${role} уже есть.`;
            case "notGranted":
                return `У чата ${targetChatId} нет роли ${role}, выданной напрямую. `
                    + "Если право приходит из другой роли, отзывать надо её — см. /whoami этого чата.";
            case "unknownChat":
                return `Чат ${targetChatId} боту ещё не писал. Пусть откроет бота и нажмёт /start.`;
            case "refused":
                return REFUSAL_TEXT[change.reason];
        }
    }

    private async renderAvailable(chatId: number): Promise<string> {
        const commands = this.menus.menuFor(await this.access.permissionsOf(chatId));

        return [
            "Доступные команды:",
            ...commands.map(item => `/${item.command} — ${item.description}`),
        ].join("\n");
    }

    //Отказ публикации меню не мешает работе: команды проверяет страж, а меню — только подсказка.
    private async publishMenu(chatId: number): Promise<void> {
        try {
            await this.menus.publishChatMenu(chatId, await this.access.permissionsOf(chatId));
        } catch (error) {
            this.logger.warn({error, chatId}, "Не удалось опубликовать меню команд чата");
        }
    }
}

function describeAssignment(assignment: RoleAssignment): string {
    const details = [
        assignment.grantedBy === undefined ? undefined : `выдал ${assignment.grantedBy}`,
        assignment.note,
    ].filter(detail => detail !== undefined);

    return details.length === 0 ? assignment.role : `${assignment.role} (${details.join(", ")})`;
}

//Справочник ролей для администратора: что входит в группу и какие команды даёт право.
//Собирается из тех же таблиц, что проверяет страж, поэтому врать не может.
export function renderRoleCatalog(): string[] {
    const commandsOf = new Map<Permission, string[]>();

    for (const [command, permission] of Object.entries(COMMAND_ACCESS)) {
        commandsOf.set(permission, [...commandsOf.get(permission) ?? [], `/${command}`]);
    }

    return [
        "Группы:",
        ...ROLE_GROUPS.map(group => `${group}: ${ROLE_HIERARCHY[group].join(", ")}`),
        "",
        "Права:",
        ...PERMISSIONS
            .filter(permission => permission !== "ROLE_ANONYMOUS")
            .map(permission => `${permission}: ${(commandsOf.get(permission) ?? []).join(" ")}`),
    ];
}

function fitMessage(lines: readonly string[]): string {
    const kept: string[] = [];
    let length = 0;

    for (const [index, line] of lines.entries()) {
        if (length + line.length + 1 > MESSAGE_BUDGET) {
            kept.push(`…и ещё ${lines.length - index} строк`);
            break;
        }

        kept.push(line);
        length += line.length + 1;
    }

    return kept.join("\n");
}

function actorOf(ctx: Context): AccessActor {
    return {chatId: ctx.chatId ?? 0, userId: ctx.from?.id};
}

function argumentOf(ctx: Context): string {
    return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

function toTelegramChat(chat: NonNullable<Context["chat"]>): TelegramChat {
    return {
        chatId: chat.id,
        type: chat.type as TelegramChatType,
        title: "title" in chat ? chat.title : chat.username ?? chat.first_name,
    };
}
