import type {Composer, Context} from "grammy";
import type {BotCommand} from "grammy/types";
import type {Logger} from "pino";
import type {BotCommands} from "./TelegramBot.js";
import type {TelegramChat, TelegramChatType} from "./TelegramChat.js";
import {
    FEEDBACK_PAGE_PATTERN,
    FEEDBACK_PAGE_SIZE,
    FEEDBACK_REFUSAL_TEXT,
    FEEDBACK_WINDOW_SECONDS,
    decodeFeedbackPage,
    encodeFeedbackPage,
    feedbackPageCount,
    feedbackRefusal,
    renderDelivery,
    renderFeedbackList,
    renderReply,
    type FeedbackAuthor,
    type FeedbackThread,
} from "./FeedbackMessages.js";
import {pagingKeyboard} from "./pagingKeyboard.js";

export interface NewFeedback {
    chatId: number;
    userId: number | undefined;
    author: string;
    text: string;
}

export interface StoredFeedback {
    id: number;
    chatId: number;
    text: string;
}

//Ответ администратора, как он сохраняется (итерация 23).
export interface NewFeedbackReply {
    feedbackId: number;
    adminChatId: number;
    adminUserId: number | undefined;
    text: string;
    delivered: boolean;
}

//Хранилище обратной связи глазами команд.
export interface FeedbackStore {
    save(feedback: NewFeedback): Promise<number>;

    addReply(reply: NewFeedbackReply): Promise<void>;

    countFeedback(): Promise<number>;

    findFeedbackPage(limit: number, offset: number): Promise<FeedbackThread[]>;

    countRecent(chatId: number, windowSeconds: number): Promise<number>;

    addDelivery(feedbackId: number, adminChatId: number, adminMessageId: number): Promise<void>;

    findByDelivery(adminChatId: number, adminMessageId: number): Promise<StoredFeedback | undefined>;
}

//Отправка, которая возвращает id отправленного сообщения: по нему потом находится, на что ответили.
export interface FeedbackSender {
    send(chatId: number, html: string): Promise<number>;
}

export interface ChatRegistry {
    saveChat(chat: TelegramChat): Promise<void>;
}

//Обратная связь: /message <текст> — от кого угодно, даже без ролей (у кого роль отобрали, должен
//иметь возможность попросить её назад); /reply — ответ автору, ответом на доставленное сообщение.
//
//Получатели — FEEDBACK_CHAT_ID, а если он пуст, все из TELEGRAM_ROOT_CHAT_IDS. Решает composition
//root; сюда приходит готовый список.
//
//Опрашивать отдельный канал не нужно: бот и так получает всё, что ему пишут, а доставка администратору —
//обычное исходящее сообщение, как уведомления о серверах.
export class FeedbackCommands implements BotCommands {
    public constructor(
        private readonly store: FeedbackStore,
        private readonly chats: ChatRegistry,
        private readonly sender: FeedbackSender,
        private readonly recipients: readonly number[],
        private readonly logger: Logger,
    ) {
    }

    ///reply в меню нет намеренно: меню у всех одно по правам, а /reply открыт всем, хотя нужен только
    //получателям. Как им пользоваться, написано в каждом доставленном сообщении.
    public describe(): BotCommand[] {
        return [
            {command: "message", description: "написать администратору: пожелание, вопрос, просьба"},
        ];
    }

    public register(bot: Composer<Context>): void {
        bot.command("message", ctx => this.submit(ctx, textOf(ctx)));
        bot.command("reply", ctx => this.reply(ctx, textOf(ctx)));
        //Вся переписка: обращения и ответы (итерация 23). Право ROLE_FEEDBACK_VIEW — только root.
        bot.command("feedback", ctx => this.showFeedback(ctx, 0, "reply"));
        bot.callbackQuery(FEEDBACK_PAGE_PATTERN, async ctx => {
            await ctx.answerCallbackQuery();
            await this.showFeedback(ctx, decodeFeedbackPage(ctx.callbackQuery.data) ?? 0, "edit");
        });
    }

    private async showFeedback(ctx: Context, requestedPage: number, how: "reply" | "edit"): Promise<void> {
        const total = await this.store.countFeedback();
        const page = Math.min(Math.max(requestedPage, 0), feedbackPageCount(total) - 1);
        const threads = await this.store.findFeedbackPage(FEEDBACK_PAGE_SIZE, page * FEEDBACK_PAGE_SIZE);
        const {text, pages} = renderFeedbackList(threads, total, page);
        const keyboard = pagingKeyboard(page, pages, encodeFeedbackPage);
        const options = {parse_mode: "HTML" as const, ...(keyboard ? {reply_markup: keyboard} : {})};

        if (how === "reply") {
            await ctx.reply(text, options);
            return;
        }

        //При неизменившемся тексте Telegram отвечает отказом — это не ошибка.
        await ctx.editMessageText(text, options).catch((error: unknown) => {
            this.logger.debug({error}, "Не удалось перелистнуть обратную связь");
        });
    }

    private async submit(ctx: Context, text: string): Promise<void> {
        const chat = ctx.chat;

        if (!chat) {
            return;
        }

        const refusal = feedbackRefusal(text, await this.store.countRecent(chat.id, FEEDBACK_WINDOW_SECONDS));

        if (refusal) {
            await ctx.reply(FEEDBACK_REFUSAL_TEXT[refusal]);
            return;
        }

        const author = authorOf(ctx);

        //Чат обязан быть в базе раньше сообщения: на него смотрит внешний ключ. Писать может
        //и тот, кто ни разу не нажимал /start.
        await this.chats.saveChat(toTelegramChat(chat));

        const feedbackId = await this.store.save({
            chatId: chat.id,
            userId: author.userId,
            author: describeAuthorShort(author),
            text: text.trim(),
        });
        const delivered = await this.deliver(feedbackId, author, text.trim());

        //Сообщение сохранено в любом случае; честно говорим, дошло ли оно до кого-нибудь прямо сейчас.
        await ctx.reply(delivered > 0
            ? "Спасибо, передал администратору."
            : "Спасибо, сообщение сохранено.");
    }

    //Каждому получателю отдельно: отказ одному не мешает остальным.
    private async deliver(feedbackId: number, author: FeedbackAuthor, text: string): Promise<number> {
        if (this.recipients.length === 0) {
            this.logger.warn({feedbackId}, "Обратную связь некому доставить: FEEDBACK_CHAT_ID и TELEGRAM_ROOT_CHAT_IDS пусты");
            return 0;
        }

        let delivered = 0;

        for (const recipient of this.recipients) {
            try {
                const messageId = await this.sender.send(recipient, renderDelivery(feedbackId, author, text));

                await this.store.addDelivery(feedbackId, recipient, messageId);
                delivered++;
            } catch (error) {
                this.logger.error({error, feedbackId, recipient}, "Не удалось доставить обратную связь");
            }
        }

        return delivered;
    }

    //Отвечать можно только ответом на доставленное сообщение и только из того чата, куда его
    //доставили. Это и есть проверка прав: такое сообщение бот отправил только получателю, и чужой
    //на него ответить не может — поэтому в карте прав команда открыта всем, как и /message.
    private async reply(ctx: Context, text: string): Promise<void> {
        const chatId = ctx.chatId;
        const repliedId = ctx.message?.reply_to_message?.message_id;

        if (chatId === undefined || repliedId === undefined) {
            await ctx.reply("Ответьте этой командой на сообщение обратной связи: «Ответить» → /reply текст.");
            return;
        }

        const feedback = await this.store.findByDelivery(chatId, repliedId);

        if (!feedback) {
            await ctx.reply("Это не сообщение обратной связи — ответить можно только на «✉️ Обратная связь».");
            return;
        }

        if (text.trim() === "") {
            await ctx.reply("Напишите текст ответа после команды: /reply текст.");
            return;
        }

        let delivered = true;

        try {
            await this.sender.send(feedback.chatId, renderReply(feedback.text, text.trim()));
        } catch (error) {
            delivered = false;
            this.logger.warn({error, feedbackId: feedback.id}, "Ответ на обратную связь не доставлен");
        }

        //Ответ сохраняется и недоставленным: попытка ответить — тоже часть переписки. Отказ записи
        //не отменяет уже отправленного — только в лог.
        await this.store.addReply({
            feedbackId: feedback.id,
            adminChatId: chatId,
            adminUserId: ctx.from?.id,
            text: text.trim(),
            delivered,
        }).catch((error: unknown) => {
            this.logger.error({error, feedbackId: feedback.id}, "Не удалось сохранить ответ на обратную связь");
        });

        if (!delivered) {
            await ctx.reply("Не доставлено: автор, похоже, заблокировал бота или удалил чат. Ответ сохранён.");
            return;
        }

        this.logger.info({feedbackId: feedback.id, chatId: feedback.chatId}, "Ответ на обратную связь отправлен");
        await ctx.reply(`Ответ на #${feedback.id} отправлен.`);
    }
}

function authorOf(ctx: Context): FeedbackAuthor {
    const chat = ctx.chat;
    const from = ctx.from;

    return {
        chatId: chat?.id ?? 0,
        chatType: chat?.type ?? "private",
        chatTitle: chat && "title" in chat ? chat.title : undefined,
        userId: from?.id,
        userName: from ? [from.first_name, from.last_name].filter(Boolean).join(" ") : undefined,
        username: from?.username,
    };
}

//Подпись в базе — коротко и без разметки: её читает тот, кто смотрит таблицу.
function describeAuthorShort(author: FeedbackAuthor): string {
    return [author.userName, author.username === undefined ? undefined : `@${author.username}`, author.chatTitle]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 255);
}

function toTelegramChat(chat: NonNullable<Context["chat"]>): TelegramChat {
    return {
        chatId: chat.id,
        type: chat.type as TelegramChatType,
        title: "title" in chat ? chat.title : chat.username ?? chat.first_name,
    };
}

function textOf(ctx: Context): string {
    return typeof ctx.match === "string" ? ctx.match : "";
}
