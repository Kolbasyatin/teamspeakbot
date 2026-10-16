-- Обратная связь через бота (итерация 16): /message <текст> от кого угодно, доставка администраторам,
-- ответ автору через бота.
--
-- Сообщение хранится, а не только пересылается: доставка может не пройти (Telegram недоступен,
-- получатель не писал боту), и тогда текст не должен пропасть. И по этой же таблице считается
-- частота — «не больше N за M минут» с одного чата.
--
-- chat_id — чат, откуда написали; ответ уходит туда же. user_id — кто именно, если писали из группы.
-- author — подпись для человека (имя, @username, название группы); логика на неё не завязана.

CREATE TABLE IF NOT EXISTS feedback_messages
(
    id         bigint unsigned auto_increment
        primary key,
    chat_id    bigint                                not null,
    user_id    bigint                                null,
    author     varchar(255)                          null,
    text       text                                  not null,
    created_at timestamp default current_timestamp() not null,
    constraint fk_feedback_messages_chat
        foreign key (chat_id) references telegram_chats (chat_id)
            on delete cascade,
    index ix_feedback_messages_chat_created (chat_id, created_at)
);

-- Куда сообщение доставлено: в каком чате администратора и каким сообщением бота. По этой паре
-- ответ «Ответить → /reply» находит автора. Получателей бывает несколько (все root или группа
-- обратной связи), поэтому отдельная таблица, а не колонка.
--
-- Ключ — (admin_chat_id, admin_message_id): id сообщения уникален только внутри чата.
-- Пара заодно и разрешение отвечать: такое сообщение бот отправил только в чат получателя,
-- и ответить на него можно только оттуда.

CREATE TABLE IF NOT EXISTS feedback_deliveries
(
    feedback_id      bigint unsigned not null,
    admin_chat_id    bigint          not null,
    admin_message_id bigint          not null,
    primary key (admin_chat_id, admin_message_id),
    constraint fk_feedback_deliveries_feedback
        foreign key (feedback_id) references feedback_messages (id)
            on delete cascade
);
