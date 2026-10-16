import type {Composer, Context, InlineKeyboard} from "grammy";
import type {BotCommand} from "grammy/types";
import type {Logger} from "pino";
import type {ServerPollResult} from "../monitoring/ServerQuery.js";
import type {AdminParams, AdminResult} from "../servers/ServerAdmin.js";
import type {AdminServer, AdminSource} from "../servers/ServerAdminModel.js";
import type {BotCommands} from "./TelegramBot.js";
import {parseArguments, parseId, parseNewServer} from "./ServerAdminInput.js";
import {
    ADMIN_MANAGE_PATTERN,
    ADMIN_VIEW_PATTERN,
    CATALOG_START,
    SERVER_ADMIN_HELP,
    decodeAdminButton,
    renderAdminCard,
    renderDeleteConfirm,
    renderProblems,
    type AdminButton,
} from "./ServerAdminMessages.js";
import {encodeAction, type ListOrigin} from "./ServerListMessage.js";
import {renderServerCheck} from "./ServerStatusMessage.js";
import {InlineKeyboard as Keyboard} from "grammy";

//Администрирование глазами команд: ровно то, что они вызывают. Реализует servers/ServerAdmin.
export interface ServerAdministration {
    server(id: number): Promise<AdminServer | undefined>;

    source(id: number): Promise<AdminSource | undefined>;

    createServer(name: string, gameAddress: string): Promise<AdminResult<number>>;

    editServer(id: number, params: AdminParams): Promise<AdminResult<AdminServer>>;

    deleteServer(id: number): Promise<AdminResult<void>>;

    addSource(serverId: number, type: string, params: AdminParams): Promise<AdminResult<number>>;

    editSource(sourceId: number, params: AdminParams): Promise<AdminResult<AdminSource>>;

    deleteSource(sourceId: number): Promise<AdminResult<void>>;
}

//Разовый опрос сервера по его включённым пригодным источникам — в том числе выключенного:
//администратор проверяет черновик ДО того, как показать его всем. undefined — опрашивать нечем.
//Как собрать конфиг и чем опросить, знает composition root.
export interface AdminServerChecker {
    check(serverId: number): Promise<ServerPollResult | undefined>;
}

//Команды управления серверами и кнопки админской карточки. Отдельный набор, а не добавка
//к SubscriptionCommands: у тех подписки и показ подписчику, у этих — правка списка, другие
//зависимости и другие права. Обычный список про это ничего не знает.
export class ServerAdminCommands implements BotCommands {
    public constructor(
        private readonly admin: ServerAdministration,
        private readonly checker: AdminServerChecker,
        private readonly logger: Logger,
        private readonly now: () => Date = () => new Date(),
    ) {
    }

    public describe(): BotCommand[] {
        return [
            {command: "server", description: "карточка сервера для администратора"},
            {command: "server_add", description: "добавить сервер"},
            {command: "server_edit", description: "изменить сервер"},
            {command: "server_delete", description: "удалить сервер"},
            {command: "source_add", description: "добавить источник опроса"},
            {command: "source_edit", description: "изменить источник опроса"},
            {command: "source_delete", description: "удалить источник опроса"},
        ];
    }

    public register(bot: Composer<Context>): void {
        bot.command("server", ctx => this.showServer(ctx, textOf(ctx)));
        bot.command("server_add", ctx => this.addServer(ctx, textOf(ctx)));
        bot.command("server_edit", ctx => this.editServer(ctx, textOf(ctx)));
        bot.command("server_delete", ctx => this.askDeleteServer(ctx, textOf(ctx)));
        bot.command("source_add", ctx => this.addSource(ctx, textOf(ctx)));
        bot.command("source_edit", ctx => this.editSource(ctx, textOf(ctx)));
        bot.command("source_delete", ctx => this.deleteSourceByCommand(ctx, textOf(ctx)));

        bot.callbackQuery(ADMIN_VIEW_PATTERN, ctx => this.onButton(ctx));
        bot.callbackQuery(ADMIN_MANAGE_PATTERN, ctx => this.onButton(ctx));
    }

    private async showServer(ctx: Context, text: string): Promise<void> {
        const id = parseId(text.trim());

        if (id === undefined) {
            await ctx.reply(SERVER_ADMIN_HELP, {parse_mode: "HTML"});
            return;
        }

        await this.replyWithCard(ctx, id);
    }

    private async addServer(ctx: Context, text: string): Promise<void> {
        const input = parseNewServer(text);

        if (!input) {
            await ctx.reply(SERVER_ADMIN_HELP, {parse_mode: "HTML"});
            return;
        }

        const result = await this.admin.createServer(input.name, input.address);

        if (!result.ok) {
            await ctx.reply(renderProblems(result.problems), {parse_mode: "HTML"});
            return;
        }

        await ctx.reply(
            `Сервер #${result.value} создан выключенным. Теперь источник: <code>/source_add ${result.value} a2s port=…</code>`,
            {parse_mode: "HTML"},
        );
        await this.replyWithCard(ctx, result.value);
    }

    private async editServer(ctx: Context, text: string): Promise<void> {
        const {positional, params, problems} = parseArguments(text);
        const id = parseId(positional[0]);

        if (id === undefined) {
            await ctx.reply(SERVER_ADMIN_HELP, {parse_mode: "HTML"});
            return;
        }

        const result = problems.length > 0
            ? {ok: false as const, problems}
            : await this.admin.editServer(id, params);

        if (!result.ok) {
            await ctx.reply(renderProblems(result.problems), {parse_mode: "HTML"});
            return;
        }

        await this.replyWithCard(ctx, id);
    }

    //Удаление сервера — только через подтверждение: оно уносит подписки всех чатов, а отменить его
    //нельзя. Команда лишь показывает вопрос с кнопкой.
    private async askDeleteServer(ctx: Context, text: string): Promise<void> {
        const id = parseId(text.trim());
        const server = id === undefined ? undefined : await this.admin.server(id);

        if (!server) {
            await ctx.reply(id === undefined ? SERVER_ADMIN_HELP : `Сервера #${id} нет.`, {parse_mode: "HTML"});
            return;
        }

        const {text: question, keyboard} = renderDeleteConfirm(server, CATALOG_START);

        await ctx.reply(question, {parse_mode: "HTML", reply_markup: keyboard});
    }

    private async addSource(ctx: Context, text: string): Promise<void> {
        const {positional, params, problems} = parseArguments(text);
        const serverId = parseId(positional[0]);
        const type = positional[1];

        if (serverId === undefined || type === undefined) {
            await ctx.reply(SERVER_ADMIN_HELP, {parse_mode: "HTML"});
            return;
        }

        const result = problems.length > 0
            ? {ok: false as const, problems}
            : await this.admin.addSource(serverId, type, params);

        if (!result.ok) {
            await ctx.reply(renderProblems(result.problems), {parse_mode: "HTML"});
            return;
        }

        await ctx.reply(`Источник #${result.value} добавлен. Проверяю сервер…`);
        await this.replyWithCheck(ctx, serverId);
        await this.replyWithCard(ctx, serverId);
    }

    private async editSource(ctx: Context, text: string): Promise<void> {
        const {positional, params, problems} = parseArguments(text);
        const sourceId = parseId(positional[0]);

        if (sourceId === undefined) {
            await ctx.reply(SERVER_ADMIN_HELP, {parse_mode: "HTML"});
            return;
        }

        const result = problems.length > 0
            ? {ok: false as const, problems}
            : await this.admin.editSource(sourceId, params);

        if (!result.ok) {
            await ctx.reply(renderProblems(result.problems), {parse_mode: "HTML"});
            return;
        }

        await this.replyWithCard(ctx, result.value.serverId);
    }

    private async deleteSourceByCommand(ctx: Context, text: string): Promise<void> {
        const sourceId = parseId(text.trim());

        if (sourceId === undefined) {
            await ctx.reply(SERVER_ADMIN_HELP, {parse_mode: "HTML"});
            return;
        }

        const result = await this.admin.deleteSource(sourceId);

        await ctx.reply(result.ok ? `Источник #${sourceId} удалён.` : renderProblems(result.problems), {parse_mode: "HTML"});
    }

    //Кнопки карточки. Таблица, а не if: новое действие без обработчика не скомпилируется.
    private readonly buttonActions: Record<AdminButton["action"], (ctx: Context, button: AdminButton) => Promise<void>> = {
        open: (ctx, button) => this.editCard(ctx, button.id, button.origin),
        check: async (ctx, button) => this.replyWithCheck(ctx, button.id),
        serverOn: (ctx, button) => this.applyToServer(ctx, button, {enabled: "on"}),
        serverOff: (ctx, button) => this.applyToServer(ctx, button, {enabled: "off"}),
        deleteAsk: async (ctx, button) => {
            const server = await this.admin.server(button.id);

            if (server) {
                const {text, keyboard} = renderDeleteConfirm(server, button.origin);

                await this.edit(ctx, text, keyboard);
            }
        },
        deleteConfirm: async (ctx, button) => {
            const result = await this.admin.deleteServer(button.id);

            await this.edit(
                ctx,
                result.ok ? `Сервер #${button.id} удалён.` : renderProblems(result.problems),
                new Keyboard().text("◀ К списку", encodeAction({...button.origin, action: "page", serverId: 0})),
            );
        },
        sourceOn: (ctx, button) => this.applyToSource(ctx, button, {enabled: "on"}),
        sourceOff: (ctx, button) => this.applyToSource(ctx, button, {enabled: "off"}),
        //undefined вместо параметров — удаление.
        sourceDelete: (ctx, button) => this.applyToSource(ctx, button, undefined),
    };

    private async onButton(ctx: Context): Promise<void> {
        const button = decodeAdminButton(ctx.callbackQuery?.data ?? "");

        if (!button) {
            await ctx.answerCallbackQuery("Кнопка устарела, откройте карточку заново");
            return;
        }

        await ctx.answerCallbackQuery();
        await this.buttonActions[button.action](ctx, button);
    }

    private async applyToServer(ctx: Context, button: AdminButton, params: AdminParams): Promise<void> {
        const result = await this.admin.editServer(button.id, params);

        if (!result.ok) {
            await ctx.reply(renderProblems(result.problems), {parse_mode: "HTML"});
            return;
        }

        await this.editCard(ctx, button.id, button.origin);
    }

    //Кнопки источника несут id источника, а карточку перерисовывать надо у его сервера — поэтому
    //сервер ищется до правки: после удаления источника спросить будет не у кого.
    private async applyToSource(ctx: Context, button: AdminButton, params: AdminParams | undefined): Promise<void> {
        const serverId = (await this.admin.source(button.id))?.serverId;
        const result = params === undefined
            ? await this.admin.deleteSource(button.id)
            : await this.admin.editSource(button.id, params);

        if (!result.ok) {
            await ctx.reply(renderProblems(result.problems), {parse_mode: "HTML"});
            return;
        }

        if (serverId !== undefined) {
            await this.editCard(ctx, serverId, button.origin);
        }
    }

    private async replyWithCard(ctx: Context, serverId: number): Promise<void> {
        const server = await this.admin.server(serverId);

        if (!server) {
            await ctx.reply(`Сервера #${serverId} нет.`);
            return;
        }

        const {text, keyboard} = renderAdminCard(server, CATALOG_START);

        await ctx.reply(text, {parse_mode: "HTML", reply_markup: keyboard});
    }

    private async editCard(ctx: Context, serverId: number, origin: ListOrigin): Promise<void> {
        const server = await this.admin.server(serverId);

        if (!server) {
            await this.edit(ctx, `Сервера #${serverId} больше нет.`, new Keyboard()
                .text("◀ К списку", encodeAction({...origin, action: "page", serverId: 0})));
            return;
        }

        const {text, keyboard} = renderAdminCard(server, origin);

        await this.edit(ctx, text, keyboard);
    }

    //Проверка — новым сообщением, как в обычной карточке: карточка — табло, ответ — переписка.
    private async replyWithCheck(ctx: Context, serverId: number): Promise<void> {
        const server = await this.admin.server(serverId);
        const result = server ? await this.checker.check(serverId) : undefined;

        if (!server || !result) {
            await ctx.reply("Проверить нечем: у сервера нет включённого источника с пригодным конфигом.");
            return;
        }

        await ctx.reply(renderServerCheck(server, result, this.now()), {parse_mode: "HTML"});
    }

    //Правим то же сообщение. Отказ Telegram на неизменившийся текст — не ошибка (двойное нажатие).
    private async edit(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
        await ctx.editMessageText(text, {parse_mode: "HTML", reply_markup: keyboard}).catch((error: unknown) => {
            this.logger.debug({error}, "Не удалось обновить админскую карточку");
        });
    }
}

function textOf(ctx: Context): string {
    return typeof ctx.match === "string" ? ctx.match : "";
}

