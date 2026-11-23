import type {Composer, Context} from "grammy";
import type {BotCommand, Message} from "grammy/types";
import type {Logger} from "pino";
import type {BotCommands} from "./TelegramBot.js";
import {
    listNameProblem,
    parseTarget,
    type BroadcastContent,
    type BroadcastStore,
    type MailingListStore,
    type StoredBroadcast,
} from "../broadcasts/Broadcasts.js";
import {
    BROADCAST_CONFIRM_PATTERN,
    LIST_NAME_PROBLEM_TEXT,
    LISTS_USAGE,
    SEND_USAGE,
    decodeBroadcastDecision,
    renderCancelled,
    renderConfirmation,
    renderListMembers,
    renderListsOverview,
    renderMembershipChange,
    renderRecentBroadcasts,
    renderStarted,
} from "./BroadcastMessages.js";
import {replyAuthor} from "./AccessCommands.js";

//Запуск подтверждённой рассылки. Реализует BroadcastRunner; здесь — только «запусти в фоне».
export interface BroadcastLauncher {
    run(broadcast: StoredBroadcast): Promise<unknown>;
}

//Рассылки и списки рассылки (итерация 24). Всё под одним правом ROLE_BROADCAST, которое есть
//только у root и проверяется по человеку: рассылка — действие, а не просмотр (commandAccess.ts).
//
//Рассылка в два шага: команда готовит её и спрашивает «Отправить N чатам?», кнопка запускает.
//Одна опечатка в «all» без подтверждения — сообщение всем.
export class BroadcastCommands implements BotCommands {
    public constructor(
        private readonly broadcasts: BroadcastStore,
        private readonly lists: MailingListStore,
        private readonly launcher: BroadcastLauncher,
        private readonly logger: Logger,
    ) {
    }

    public describe(): BotCommand[] {
        return [
            {command: "send", description: "рассылка: /send <кому> ответом на сообщение"},
            {command: "lists", description: "списки рассылки"},
            {command: "broadcasts", description: "последние рассылки"},
        ];
    }

    public register(bot: Composer<Context>): void {
        bot.command("send", ctx => this.prepare(ctx, argumentOf(ctx)));
        bot.callbackQuery(BROADCAST_CONFIRM_PATTERN, ctx => this.decide(ctx));
        bot.command("broadcasts", async ctx => {
            await ctx.reply(renderRecentBroadcasts(await this.broadcasts.findRecentBroadcasts(10)), {parse_mode: "HTML"});
        });

        bot.command("lists", ctx => this.showLists(ctx, argumentOf(ctx)));
        bot.command("list_add", ctx => this.addList(ctx, argumentOf(ctx)));
        bot.command("list_delete", ctx => this.deleteList(ctx, argumentOf(ctx)));
        bot.command("list_include", ctx => this.changeMembers(ctx, argumentOf(ctx), "include"));
        bot.command("list_exclude", ctx => this.changeMembers(ctx, argumentOf(ctx), "exclude"));
    }

    private async prepare(ctx: Context, argument: string): Promise<void> {
        const [rawTarget = ""] = argument.split(/\s+/);
        const target = parseTarget(rawTarget);
        const author = ctx.from?.id;
        const chatId = ctx.chatId;
        const text = argument.slice(rawTarget.length).trim();
        const reply = sourceMessage(ctx.message?.reply_to_message);

        if (!target || author === undefined || chatId === undefined || (!reply && text === "")) {
            await ctx.reply(SEND_USAGE, {parse_mode: "HTML"});
            return;
        }

        if (target.kind === "list" && await this.lists.listMembers(target.name) === undefined) {
            await ctx.reply(`Списка «${target.name}» нет. Списки — /lists.`);
            return;
        }

        //Ответ на сообщение важнее текста в команде: копия сохраняет разметку и вложения.
        const content: BroadcastContent = reply
            ? {kind: "copy", fromChatId: chatId, messageId: reply.message_id}
            : {kind: "text", text};
        const preview = reply ? reply.text ?? reply.caption : text;
        const recipients = (await this.broadcasts.resolveRecipients(target)).length;

        if (recipients === 0) {
            await ctx.reply("Некому отправлять: адресатов нет или все недоступны.");
            return;
        }

        const broadcastId = await this.broadcasts.createBroadcast({authorUserId: author, authorChatId: chatId, content, preview, target});
        const confirmation = renderConfirmation(broadcastId, target, recipients, preview);

        await ctx.reply(confirmation.text, {parse_mode: "HTML", reply_markup: confirmation.keyboard});
    }

    private async decide(ctx: Context): Promise<void> {
        const decision = decodeBroadcastDecision(ctx.callbackQuery?.data ?? "");
        const broadcast = decision && await this.broadcasts.findBroadcast(decision.broadcastId);

        if (!decision || !broadcast) {
            await ctx.answerCallbackQuery("Рассылка не найдена");
            return;
        }

        //Право проверено стражем по нажавшему; запускать чужую рассылку всё равно нельзя.
        if (ctx.from?.id !== broadcast.authorUserId) {
            await ctx.answerCallbackQuery("Подтверждает автор рассылки");
            return;
        }

        if (!decision.confirm) {
            const cancelled = await this.broadcasts.cancelBroadcast(broadcast.id);
            await ctx.answerCallbackQuery(cancelled ? "Отменено" : "Уже не ждёт подтверждения");
            if (cancelled) {
                await this.edit(ctx, renderCancelled(broadcast.id));
            }
            return;
        }

        //Переход pending → sending атомарный: двойное нажатие не запустит рассылку дважды.
        if (!await this.broadcasts.startBroadcast(broadcast.id)) {
            await ctx.answerCallbackQuery("Уже запущена или отменена");
            return;
        }

        await ctx.answerCallbackQuery("Отправляю");
        await this.edit(ctx, renderStarted(broadcast.id, broadcast.target));

        //В фоне: большая рассылка дольше дедлайна обработки апдейта. Отчёт пришлёт сам рассыльщик.
        void this.launcher.run(broadcast).catch((error: unknown) => {
            this.logger.error({error, broadcastId: broadcast.id}, "Рассылка упала");
        });
    }

    private async showLists(ctx: Context, argument: string): Promise<void> {
        const name = argument.trim().toLowerCase();

        if (name === "") {
            await ctx.reply(renderListsOverview(await this.lists.listsOverview()), {parse_mode: "HTML"});
            return;
        }

        if (name === "help") {
            await ctx.reply(LISTS_USAGE, {parse_mode: "HTML"});
            return;
        }

        const members = await this.lists.listMembers(name);

        await ctx.reply(members ? renderListMembers(name, members) : `Списка «${name}» нет.`, {parse_mode: "HTML"});
    }

    private async addList(ctx: Context, argument: string): Promise<void> {
        const [rawName = ""] = argument.split(/\s+/);
        const name = rawName.toLowerCase();
        const description = argument.slice(rawName.length).trim() || undefined;
        const author = ctx.from?.id;

        if (name === "" || author === undefined) {
            await ctx.reply(LISTS_USAGE, {parse_mode: "HTML"});
            return;
        }

        const problem = listNameProblem(name);

        if (problem) {
            await ctx.reply(LIST_NAME_PROBLEM_TEXT[problem]);
            return;
        }

        const result = await this.lists.createList(name, description, author);

        await ctx.reply(result === "created"
            ? `Список «${name}» создан. Добавить участников — /list_include ${name} <chat_id…>.`
            : `Список «${name}» уже есть.`);
    }

    private async deleteList(ctx: Context, argument: string): Promise<void> {
        const name = argument.trim().toLowerCase();

        if (name === "") {
            await ctx.reply(LISTS_USAGE, {parse_mode: "HTML"});
            return;
        }

        await ctx.reply(await this.lists.deleteList(name)
            ? `Список «${name}» удалён. Его участники остались чатами бота; кто больше ни в одном списке — теперь в unsorted.`
            : `Списка «${name}» нет.`);
    }

    //Кого — chat_id через пробел или ответом на сообщение человека (в группе так удобнее всего).
    private async changeMembers(ctx: Context, argument: string, verb: "include" | "exclude"): Promise<void> {
        const [rawName = "", ...rawIds] = argument.split(/\s+/).filter(token => token !== "");
        const name = rawName.toLowerCase();
        const author = ctx.from?.id;
        const ids = rawIds.filter(token => /^-?\d+$/.test(token)).map(Number).filter(Number.isSafeInteger);
        const replied = replyAuthor(ctx.message?.reply_to_message);
        const chatIds = ids.length > 0 ? ids : replied !== undefined ? [replied] : [];

        if (name === "" || chatIds.length === 0 || author === undefined || ids.length !== rawIds.length) {
            await ctx.reply(LISTS_USAGE, {parse_mode: "HTML"});
            return;
        }

        const change = verb === "include"
            ? await this.lists.includeChats(name, chatIds, author)
            : await this.lists.excludeChats(name, chatIds);

        await ctx.reply(change ? renderMembershipChange(verb, name, change) : `Списка «${name}» нет. Создать — /list_add ${name}.`, {parse_mode: "HTML"});
    }

    private async edit(ctx: Context, text: string): Promise<void> {
        await ctx.editMessageText(text, {parse_mode: "HTML"}).catch((error: unknown) => {
            this.logger.debug({error}, "Не удалось обновить сообщение рассылки");
        });
    }
}

//Сообщение, на которое ответили командой. Служебное «тема создана» в группе с темами — не оно:
//там им формально «отвечает» каждое сообщение.
function sourceMessage(reply: Message | undefined): Message | undefined {
    return reply && reply.forum_topic_created === undefined ? reply : undefined;
}

function argumentOf(ctx: Context): string {
    return typeof ctx.match === "string" ? ctx.match.trim() : "";
}
