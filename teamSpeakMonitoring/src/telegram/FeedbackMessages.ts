import {escapeHtml} from "./escapeHtml.js";
import {fitMessage} from "./fitMessage.js";

//Тексты обратной связи. Чистые функции: проверяются без grammy и без сети.

//Предел длины. Сообщение администратору — это текст плюс шапка, а у Telegram потолок 4096 символов;
//после экранирования HTML текст ещё и растёт. 2000 оставляют запас и всё равно больше любого отзыва.
export const MAX_FEEDBACK_LENGTH = 2_000;

//Не больше FEEDBACK_LIMIT сообщений за FEEDBACK_WINDOW_SECONDS с одного чата. Писать может кто
//угодно, даже без ролей, поэтому частота — единственная защита от засыпания администратора.
export const FEEDBACK_LIMIT = 3;
export const FEEDBACK_WINDOW_SECONDS = 600;

export type FeedbackRefusal = "empty" | "tooLong" | "rateLimited";

export function feedbackRefusal(text: string, recentCount: number): FeedbackRefusal | undefined {
    if (text.trim() === "") {
        return "empty";
    }

    if (text.length > MAX_FEEDBACK_LENGTH) {
        return "tooLong";
    }

    return recentCount >= FEEDBACK_LIMIT ? "rateLimited" : undefined;
}

export const FEEDBACK_REFUSAL_TEXT: Record<FeedbackRefusal, string> = {
    empty: "Напишите текст после команды, например:\n/message Добавьте, пожалуйста, сервер EXD #3",
    tooLong: `Слишком длинно: не больше ${MAX_FEEDBACK_LENGTH} символов. Разбейте на несколько сообщений.`,
    rateLimited: `Не больше ${FEEDBACK_LIMIT} сообщений за ${FEEDBACK_WINDOW_SECONDS / 60} минут. Попробуйте чуть позже.`,
};

//Кто написал, как это видит администратор. Из группы — и группа, и человек: ответ уйдёт в группу,
//а знать, кто именно писал, всё равно нужно.
export interface FeedbackAuthor {
    chatId: number;
    chatType: string;
    chatTitle: string | undefined;
    userId: number | undefined;
    userName: string | undefined;
    username: string | undefined;
}

export function describeAuthor(author: FeedbackAuthor): string {
    const person = [
        author.userName,
        author.username === undefined ? undefined : `@${author.username}`,
        author.userId === undefined ? undefined : `id ${author.userId}`,
    ].filter(part => part !== undefined).join(" ");

    if (author.chatType === "private") {
        return person === "" ? `chat_id ${author.chatId}` : person;
    }

    const chat = `${author.chatTitle ?? "группа"} (chat_id ${author.chatId})`;

    return person === "" ? chat : `${person} в ${chat}`;
}

export function renderDelivery(feedbackId: number, author: FeedbackAuthor, text: string): string {
    return [
        `✉️ <b>Обратная связь #${feedbackId}</b>`,
        `От: ${escapeHtml(describeAuthor(author))}`,
        "",
        escapeHtml(text),
        "",
        "<i>Ответить автору — ответом на это сообщение: /reply текст</i>",
    ].join("\n");
}

//Ответ автору. Его исходный вопрос цитируется: писали, может, неделю назад, и без цитаты
//«да, добавим» непонятно к чему.
export function renderReply(originalText: string, reply: string): string {
    const quoted = originalText.length > 200 ? `${originalText.slice(0, 200)}…` : originalText;

    return [
        "💬 <b>Ответ администратора</b>",
        `<i>на ваше сообщение: «${escapeHtml(quoted)}»</i>`,
        "",
        escapeHtml(reply),
    ].join("\n");
}

//Переписка целиком для /feedback (итерация 23): обращение и все ответы на него.
export interface FeedbackReplyView {
    text: string;
    createdAt: Date;
    delivered: boolean;
    adminUserId: number | undefined;
}

export interface FeedbackThread {
    id: number;
    chatId: number;
    author: string | undefined;
    text: string;
    createdAt: Date;
    replies: readonly FeedbackReplyView[];
}

export const FEEDBACK_PAGE_SIZE = 10;
export const FEEDBACK_PAGE_PATTERN = /^fb:(\d+)$/;

export function encodeFeedbackPage(page: number): string {
    return `fb:${page}`;
}

export function decodeFeedbackPage(data: string): number | undefined {
    const match = FEEDBACK_PAGE_PATTERN.exec(data);
    const page = match ? Number(match[1]) : undefined;

    return page !== undefined && Number.isSafeInteger(page) ? page : undefined;
}

export function feedbackPageCount(total: number): number {
    return Math.max(1, Math.ceil(total / FEEDBACK_PAGE_SIZE));
}

const STAMP = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
});

//На странице десять обращений: длинные тексты урезаются, целиком они лежат в базе.
const THREAD_TEXT_LIMIT = 300;
const REPLY_TEXT_LIMIT = 200;

export function renderFeedbackList(threads: readonly FeedbackThread[], total: number, page: number): {text: string; pages: number} {
    const pages = feedbackPageCount(total);
    const lines = [
        `<b>Обратная связь: ${total}</b> · страница ${page + 1} из ${pages}, новые сверху`,
        "История одного чата — /chats &lt;chat_id&gt;.",
    ];

    if (threads.length === 0) {
        lines.push("", "Обращений пока не было.");
    }

    for (const thread of threads) {
        lines.push(
            "",
            `✉️ <b>#${thread.id}</b> · ${STAMP.format(thread.createdAt)} · ${escapeHtml(thread.author ?? "без подписи")} · <code>${thread.chatId}</code>`,
            escapeHtml(cut(thread.text, THREAD_TEXT_LIMIT)),
        );

        if (thread.replies.length === 0) {
            lines.push("   <i>без ответа</i>");
        }

        for (const reply of thread.replies) {
            const failed = reply.delivered ? "" : " · <b>не доставлен</b>";
            lines.push(`   💬 ${STAMP.format(reply.createdAt)}${failed}: ${escapeHtml(cut(reply.text, REPLY_TEXT_LIMIT))}`);
        }
    }

    //Десять обращений с несколькими ответами могут не влезть в одно сообщение: хвост урезается.
    return {text: fitMessage(lines), pages};
}

function cut(text: string, limit: number): string {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
