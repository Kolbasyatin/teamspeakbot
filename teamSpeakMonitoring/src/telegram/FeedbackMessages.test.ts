import test from "node:test";
import assert from "node:assert/strict";
import {
    FEEDBACK_LIMIT,
    MAX_FEEDBACK_LENGTH,
    describeAuthor,
    feedbackRefusal,
    renderDelivery,
    renderReply,
    type FeedbackAuthor,
} from "./FeedbackMessages.js";

const PERSON: FeedbackAuthor = {
    chatId: 555,
    chatType: "private",
    chatTitle: undefined,
    userId: 555,
    userName: "Вася",
    username: "vasya",
};

test("пустое, длинное и слишком частое — отказ; обычное — проходит", () => {
    assert.equal(feedbackRefusal("  ", 0), "empty");
    assert.equal(feedbackRefusal("x".repeat(MAX_FEEDBACK_LENGTH + 1), 0), "tooLong");
    assert.equal(feedbackRefusal("привет", FEEDBACK_LIMIT), "rateLimited");
    assert.equal(feedbackRefusal("привет", FEEDBACK_LIMIT - 1), undefined);
});

test("автор из лички и из группы", () => {
    assert.equal(describeAuthor(PERSON), "Вася @vasya id 555");
    assert.equal(
        describeAuthor({...PERSON, chatId: -100, chatType: "supergroup", chatTitle: "Клан"}),
        "Вася @vasya id 555 в Клан (chat_id -100)",
    );
});

test("доставка экранирует текст и подсказывает, как ответить", () => {
    const text = renderDelivery(12, {...PERSON, userName: "<b>Вася</b>"}, "сервер <EXD> & co");

    assert.match(text, /Обратная связь #12/);
    assert.match(text, /&lt;b&gt;Вася&lt;\/b&gt;/);
    assert.match(text, /сервер &lt;EXD&gt; &amp; co/);
    assert.match(text, /\/reply текст/);
});

test("ответ цитирует вопрос, длинный — обрезает", () => {
    assert.match(renderReply("Добавьте EXD", "Добавили"), /«Добавьте EXD»[\s\S]*Добавили/);
    assert.match(renderReply("x".repeat(300), "ok"), /x{200}…»/);
});
