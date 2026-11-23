import {InlineKeyboard} from "grammy";
import {escapeHtml} from "./escapeHtml.js";
import type {TelegramChatType} from "./TelegramChat.js";

//Список чатов, которые писали боту (/chats): текст и кнопки листания чистой функцией,
//без grammy-контекста и без базы — проверяется без сети.

export interface ChatListEntry {
    chatId: number;
    type: TelegramChatType;
    //Название группы или @username / имя для лички; бывает пустым.
    title: string | undefined;
    //Когда чат впервые попал в базу — первый /start или первое действие с ботом.
    firstSeenAt: Date;
    //Роли из базы как есть. ROLE_ROOT здесь не бывает — он из конфигурации, см. isRoot.
    roles: readonly string[];
    serverSubscriptions: number;
}

export interface ChatCounts {
    total: number;
    private: number;
}

export interface ChatListPage {
    entries: readonly ChatListEntry[];
    counts: ChatCounts;
    //С нуля. Страница за последней (чаты удалили, пока список был открыт) приводится к последней
    //до запроса к базе — см. clampPage.
    page: number;
    isRoot: (chatId: number) => boolean;
}

export const CHAT_LIST_PAGE_SIZE = 20;

//Префикс кнопок листания. Не пересекается с чужими: c: и m: у каталога требуют второго двоеточия
//сразу после буквы, p*: — игроки, k — карточка, a: — админка.
export const CHAT_LIST_PATTERN = /^ch:(\d+)$/;

export function encodeChatListPage(page: number): string {
    return `ch:${page}`;
}

export function decodeChatListPage(data: string): number | undefined {
    const match = CHAT_LIST_PATTERN.exec(data);
    const page = match ? Number(match[1]) : undefined;

    return page !== undefined && Number.isSafeInteger(page) ? page : undefined;
}

export function pageCountOf(total: number): number {
    return Math.max(1, Math.ceil(total / CHAT_LIST_PAGE_SIZE));
}

export function clampPage(page: number, total: number): number {
    return Math.min(Math.max(page, 0), pageCountOf(total) - 1);
}

const TYPE_ICON: Record<TelegramChatType, string> = {
    private: "👤",
    group: "👥",
    supergroup: "👥",
    channel: "📢",
};

//Длинное название группы съело бы бюджет сообщения: на странице двадцать чатов.
const TITLE_LIMIT = 40;

const DATE = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Moscow",
});

export function renderChatList(view: ChatListPage): {text: string; keyboard: InlineKeyboard | undefined} {
    const pages = pageCountOf(view.counts.total);
    const others = view.counts.total - view.counts.private;
    const lines = [
        `<b>Чаты, писавшие боту: ${view.counts.total}</b> (личек ${view.counts.private}, групп и каналов ${others})`,
        `Страница ${view.page + 1} из ${pages}, новые сверху. Роли одного чата — /roles &lt;chat_id&gt;.`,
        "",
    ];

    if (view.entries.length === 0) {
        lines.push("Никто ещё не писал боту.");
    }

    for (const entry of view.entries) {
        lines.push(...renderEntry(entry, view.isRoot(entry.chatId)));
    }

    return {text: lines.join("\n"), keyboard: pagingKeyboard(view.page, pages)};
}

function renderEntry(entry: ChatListEntry, isRoot: boolean): string[] {
    //Роли — в той форме, в какой их пишут в /grant: ts_user, а не ROLE_TS_USER.
    const roles = [...(isRoot ? ["root"] : []), ...entry.roles.map(shortRole)];
    const details = [
        `с ${DATE.format(entry.firstSeenAt)}`,
        roles.length > 0 ? roles.join(", ") : "без ролей",
        ...(entry.serverSubscriptions > 0 ? [`подписок ${entry.serverSubscriptions}`] : []),
    ];

    return [
        `${TYPE_ICON[entry.type]} ${escapeHtml(titleOf(entry))} — <code>${entry.chatId}</code>`,
        `      ${escapeHtml(details.join(" · "))}`,
    ];
}

function titleOf(entry: ChatListEntry): string {
    const title = entry.title?.trim();

    if (!title) {
        return "без имени";
    }

    return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
}

function shortRole(role: string): string {
    return role.replace(/^ROLE_/, "").toLowerCase();
}

function pagingKeyboard(page: number, pages: number): InlineKeyboard | undefined {
    if (pages <= 1) {
        return undefined;
    }

    const keyboard = new InlineKeyboard();

    if (page > 0) {
        keyboard.text("◀", encodeChatListPage(page - 1));
    }

    if (page < pages - 1) {
        keyboard.text("▶", encodeChatListPage(page + 1));
    }

    return keyboard;
}
