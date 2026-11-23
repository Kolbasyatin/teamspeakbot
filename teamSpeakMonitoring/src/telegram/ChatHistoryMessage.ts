import type {InlineKeyboard} from "grammy";
import {escapeHtml} from "./escapeHtml.js";
import {pagingKeyboard} from "./pagingKeyboard.js";
import {fitMessage} from "./fitMessage.js";
import {renderChatHeader, type ChatListEntry} from "./ChatListMessage.js";

//История отношений одного чата с ботом (/chats <chat_id>, итерация 23): команды и кнопки,
//выдача и отзыв прав, обратная связь и ответы на неё — одной лентой, новые сверху.

export type ChatHistoryEntry =
    | {kind: "command" | "button"; at: Date; userId: number | undefined; name: string; arguments: string | undefined; known: boolean; allowed: boolean}
    | {kind: "grant" | "revoke"; at: Date; role: string; actorUserId: number | undefined; note: string | undefined}
    | {kind: "feedback"; at: Date; feedbackId: number; text: string; userId: number | undefined}
    | {kind: "reply"; at: Date; feedbackId: number; text: string; delivered: boolean}
    | {kind: "broadcast"; at: Date; broadcastId: number; preview: string | undefined; status: "delivered" | "blocked" | "failed"; error: string | undefined};

export interface ChatHistoryPage {
    chatId: number;
    //undefined — чата нет в telegram_chats: он боту не писал или записи о нём не осталось.
    chat: ChatListEntry | undefined;
    isRoot: boolean;
    entries: readonly ChatHistoryEntry[];
    total: number;
    page: number;
}

//Двадцать строк по ~160 символов с шапкой укладываются в лимит Telegram; fitMessage — страховка
//на длинные аргументы, которые HTML-экранирование ещё и раздувает.
export const CHAT_HISTORY_PAGE_SIZE = 20;
export const CHAT_HISTORY_PATTERN = /^cht:(-?\d+):(\d+)$/;

export function encodeChatHistoryPage(chatId: number, page: number): string {
    return `cht:${chatId}:${page}`;
}

export function decodeChatHistoryPage(data: string): {chatId: number; page: number} | undefined {
    const match = CHAT_HISTORY_PATTERN.exec(data);

    if (!match) {
        return undefined;
    }

    const chatId = Number(match[1]);
    const page = Number(match[2]);

    return Number.isSafeInteger(chatId) && Number.isSafeInteger(page) ? {chatId, page} : undefined;
}

export function historyPageCount(total: number): number {
    return Math.max(1, Math.ceil(total / CHAT_HISTORY_PAGE_SIZE));
}

const STAMP = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
});

const TEXT_LIMIT = 100;

export function renderChatHistory(view: ChatHistoryPage): {text: string; keyboard: InlineKeyboard | undefined} {
    const pages = historyPageCount(view.total);
    const lines = view.chat
        ? renderChatHeader(view.chat, view.isRoot)
        : [`❔ <code>${view.chatId}</code> — в списке чатов нет`];

    lines.push("", `<b>История: ${view.total}</b> · страница ${view.page + 1} из ${pages}, новые сверху`);

    if (view.entries.length === 0) {
        lines.push("Записей нет.");
    }

    for (const entry of view.entries) {
        lines.push(`${STAMP.format(entry.at)} ${renderEntry(entry, view.chatId)}`);
    }

    return {
        text: fitMessage(lines),
        keyboard: pagingKeyboard(view.page, pages, page => encodeChatHistoryPage(view.chatId, page)),
    };
}

function renderEntry(entry: ChatHistoryEntry, chatId: number): string {
    switch (entry.kind) {
        case "command":
        case "button": {
            const what = entry.kind === "command"
                ? `/${entry.name}${entry.arguments ? ` ${entry.arguments}` : ""}`
                : `кнопка ${entry.name}`;
            const icon = !entry.known ? "❔" : entry.allowed ? (entry.kind === "command" ? "⌨️" : "🔘") : "⛔";
            const verdict = !entry.known ? " — нет такой" : entry.allowed ? "" : " — нет прав";

            return `${icon} ${escapeHtml(cut(what))}${verdict}${byWhom(entry.userId, chatId)}`;
        }
        case "grant":
        case "revoke": {
            const verb = entry.kind === "grant" ? "➕ выдана" : "➖ отозвана";
            const actor = entry.actorUserId === undefined ? "автоматически" : `кем <code>${entry.actorUserId}</code>`;
            const note = entry.note ? ` · «${escapeHtml(cut(entry.note))}»` : "";

            return `${verb} ${escapeHtml(shortRole(entry.role))} — ${actor}${note}`;
        }
        case "feedback":
            return `✉️ #${entry.feedbackId}: ${escapeHtml(cut(entry.text))}${byWhom(entry.userId, chatId)}`;
        case "reply":
            return `💬 ответ на #${entry.feedbackId}${entry.delivered ? "" : " (не доставлен)"}: ${escapeHtml(cut(entry.text))}`;
        case "broadcast": {
            const verdict = entry.status === "delivered" ? "" : ` (${entry.status === "blocked" ? "недоступен" : "ошибка"}${entry.error ? `: ${escapeHtml(cut(entry.error))}` : ""})`;

            return `📣 рассылка #${entry.broadcastId}${verdict}: ${escapeHtml(cut(entry.preview ?? "вложение без текста"))}`;
        }
    }
}

//В группе команды набирают разные люди — их видно; в личке это сам чат, и подпись лишняя.
function byWhom(userId: number | undefined, chatId: number): string {
    return userId !== undefined && userId !== chatId ? ` · от <code>${userId}</code>` : "";
}

function shortRole(role: string): string {
    return role.replace(/^ROLE_/, "").toLowerCase();
}

function cut(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT - 1)}…` : flat;
}
