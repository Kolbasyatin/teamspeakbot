-- Рассылки и списки рассылки (итерация 24). Списки — «кому мы пишем», а не «что чату можно»:
-- с ролями (telegram_chat_roles) они не пересекаются, и одно другим не выражается (rbac.md).
-- Встроенные адресаты all и unsorted не хранятся — вычисляются из telegram_chats и участников.

-- Чат заблокировал бота, удалил аккаунт или выгнал бота из группы — Telegram отвечает 403.
-- В рассылки по спискам и всем такой чат не попадает. Пометка снимается, как только чат снова
-- пишет боту (SubscriptionRepository.saveChat) или доставка ему всё-таки проходит.
ALTER TABLE telegram_chats
    ADD COLUMN IF NOT EXISTS blocked_at timestamp null;

-- Список рассылки. name — латиницей, им список называют в командах; all и unsorted заняты.
CREATE TABLE IF NOT EXISTS mailing_lists
(
    id          bigint unsigned auto_increment
        primary key,
    name        varchar(32)                           not null,
    description varchar(255)                          null,
    created_by  bigint                                null,
    created_at  timestamp default current_timestamp() not null,
    constraint uq_mailing_lists_name unique (name)
);

-- Кто в списке. Чат может быть в нескольких списках сразу; «перевести» — добавить и убрать.
CREATE TABLE IF NOT EXISTS mailing_list_members
(
    list_id  bigint unsigned                       not null,
    chat_id  bigint                                not null,
    added_by bigint                                null,
    added_at timestamp default current_timestamp() not null,
    primary key (list_id, chat_id),
    constraint fk_mailing_list_members_list
        foreign key (list_id) references mailing_lists (id)
            on delete cascade,
    constraint fk_mailing_list_members_chat
        foreign key (chat_id) references telegram_chats (chat_id)
            on delete cascade,
    index ix_mailing_list_members_chat (chat_id)
);

-- Одна рассылка. Содержимое — либо копия сообщения автора (copyMessage сохраняет разметку
-- и вложения: source_chat_id + source_message_id), либо простой текст (text). preview — начало
-- текста для журнала и истории. target — как адресата назвали: chat:<id>, list:<имя>, all, unsorted.
-- pending — ждёт подтверждения; sending — идёт; interrupted — процесс перезапустился посреди
-- рассылки (недоставленным она уже не уйдёт, см. BroadcastRunner); done; cancelled.
CREATE TABLE IF NOT EXISTS broadcasts
(
    id                bigint unsigned auto_increment
        primary key,
    author_user_id    bigint                                                              not null,
    author_chat_id    bigint                                                              not null,
    source_chat_id    bigint                                                              null,
    source_message_id bigint                                                              null,
    text              text                                                                null,
    preview           varchar(255)                                                        null,
    target            varchar(64)                                                         not null,
    status            enum ('pending','sending','done','cancelled','interrupted')         not null,
    recipients        int        default 0                                                not null,
    delivered         int        default 0                                                not null,
    blocked           int        default 0                                                not null,
    failed            int        default 0                                                not null,
    created_at        timestamp  default current_timestamp()                              not null,
    finished_at       timestamp                                                           null
);

-- Итог по каждому адресату. Ключ (рассылка, чат): повтор не создаёт второй строки.
CREATE TABLE IF NOT EXISTS broadcast_deliveries
(
    broadcast_id bigint unsigned                       not null,
    chat_id      bigint                                not null,
    status       enum ('delivered','blocked','failed') not null,
    error        varchar(255)                          null,
    delivered_at timestamp default current_timestamp() not null,
    primary key (broadcast_id, chat_id),
    constraint fk_broadcast_deliveries_broadcast
        foreign key (broadcast_id) references broadcasts (id)
            on delete cascade,
    index ix_broadcast_deliveries_chat (chat_id, delivered_at)
);
