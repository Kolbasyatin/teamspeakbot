import {escapeHtml} from "./escapeHtml.js";

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
