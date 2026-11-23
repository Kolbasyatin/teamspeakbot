-- Журналы отношений чата и бота (итерация 23): ответы на обратную связь, история выдачи прав
-- и все команды и кнопки. Всё это видно в /chats <chat_id> одной лентой, ответы — ещё и в /feedback.

-- Ответ администратора на обратную связь (/reply). До итерации 23 текст ответа уходил автору
-- и нигде не оставался — переписка в базе была только наполовину. Пишется и недоставленный ответ:
-- что администратор пытался ответить, тоже часть переписки.
CREATE TABLE IF NOT EXISTS feedback_replies
(
    id            bigint unsigned auto_increment
        primary key,
    feedback_id   bigint unsigned                       not null,
    admin_chat_id bigint                                not null,
    admin_user_id bigint                                null,
    text          text                                  not null,
    delivered     tinyint(1)                            not null,
    created_at    timestamp default current_timestamp() not null,
    constraint fk_feedback_replies_feedback
        foreign key (feedback_id) references feedback_messages (id)
            on delete cascade,
    index ix_feedback_replies_feedback (feedback_id)
);

-- История прав: каждая выдача и каждый отзыв. telegram_chat_roles хранит только то, что действует
-- сейчас, и отзыв стирает строку вместе с тем, кто и когда выдавал. Пишется в той же транзакции,
-- что и само изменение (RoleRepository). actor_user_id NULL — выдано автоматически (роль по умолчанию
-- при первом /start). Попытки без прав сюда не попадают — они видны в журнале команд.
CREATE TABLE IF NOT EXISTS role_events
(
    id            bigint unsigned auto_increment
        primary key,
    chat_id       bigint                                not null,
    role          varchar(64)                           not null,
    action        enum ('grant','revoke')               not null,
    actor_user_id bigint                                null,
    note          varchar(255)                          null,
    created_at    timestamp default current_timestamp() not null,
    constraint fk_role_events_chat
        foreign key (chat_id) references telegram_chats (chat_id)
            on delete cascade,
    index ix_role_events_chat_created (chat_id, created_at)
);

-- Каждая команда и кнопка, дошедшая до стража прав, с его решением. Без внешнего ключа на
-- telegram_chats намеренно: страж стоит раньше обработчиков, и первый /start нового чата приходит
-- до того, как чат записан. Аргументы обрезаются: журнал — чтобы видеть, что человек делал,
-- а не архив текстов (тексты обратной связи и так лежат в feedback_messages).
-- name — имя команды без «/» или данные кнопки (callback_data не длиннее 64 байт).
-- permission NULL — команды нет в карте прав (незнакомая или чужая).
CREATE TABLE IF NOT EXISTS telegram_command_log
(
    id         bigint unsigned auto_increment
        primary key,
    chat_id    bigint                                   not null,
    user_id    bigint                                   null,
    kind       enum ('command','button')                not null,
    name       varchar(64)                              not null,
    arguments  varchar(255)                             null,
    permission varchar(64)                              null,
    allowed    tinyint(1)                               not null,
    created_at timestamp(3) default current_timestamp(3) not null,
    index ix_telegram_command_log_chat_created (chat_id, created_at)
);
