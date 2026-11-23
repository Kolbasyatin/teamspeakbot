import type {Composer, Context, InlineKeyboard} from "grammy";
import type {BotCommand} from "grammy/types";
import type {Logger} from "pino";
import type {BotCommands} from "./TelegramBot.js";
import {
    CHAT_LIST_PAGE_SIZE,
    CHAT_LIST_PATTERN,
    clampPage,
    decodeChatListPage,
    renderChatList,
    type ChatCounts,
    type ChatListEntry,
} from "./ChatListMessage.js";

//Чаты глазами команды: два вопроса, а не весь репозиторий.
export interface ChatDirectory {
    countChats(): Promise<ChatCounts>;

    findChatPage(limit: number, offset: number): Promise<ChatListEntry[]>;
}

//root не хранится в базе (он из TELEGRAM_ROOT_CHAT_IDS), поэтому отметку «root» в списке
//ставит AccessControl, а не запрос.
export interface RootChecker {
    isRoot(chatId: number): boolean;
}

///chats — кто писал боту: личка или группа, с какого дня, какие роли и сколько подписок.
//Отдельный набор, а не ещё одна команда в AccessCommands: у неё своё хранилище и своё право
//(ROLE_CHAT_LIST), а с раздачей прав её роднит только аудитория.
export class ChatListCommands implements BotCommands {
    public constructor(
        private readonly directory: ChatDirectory,
        private readonly roots: RootChecker,
        private readonly logger: Logger,
    ) {
    }

    public describe(): BotCommand[] {
        return [{command: "chats", description: "кто писал боту"}];
    }

    public register(bot: Composer<Context>): void {
        bot.command("chats", async ctx => {
            const {text, keyboard} = await this.render(0);

            await ctx.reply(text, {parse_mode: "HTML", ...(keyboard ? {reply_markup: keyboard} : {})});
        });

        bot.callbackQuery(CHAT_LIST_PATTERN, ctx => this.turnPage(ctx));
    }

    private async turnPage(ctx: Context): Promise<void> {
        const page = decodeChatListPage(ctx.callbackQuery?.data ?? "");

        await ctx.answerCallbackQuery();

        if (page === undefined) {
            return;
        }

        const {text, keyboard} = await this.render(page);

        //Ошибку глушим: при неизменившемся тексте Telegram отвечает отказом.
        await ctx.editMessageText(text, {parse_mode: "HTML", ...(keyboard ? {reply_markup: keyboard} : {})})
            .catch((error: unknown) => {
                this.logger.debug({error}, "Не удалось перелистнуть список чатов");
            });
    }

    private async render(requestedPage: number): Promise<{text: string; keyboard: InlineKeyboard | undefined}> {
        const counts = await this.directory.countChats();
        //Пока список был открыт, чаты могли удалить: страница за последней показала бы пустоту.
        const page = clampPage(requestedPage, counts.total);
        const entries = await this.directory.findChatPage(CHAT_LIST_PAGE_SIZE, page * CHAT_LIST_PAGE_SIZE);

        return renderChatList({entries, counts, page, isRoot: chatId => this.roots.isRoot(chatId)});
    }
}
