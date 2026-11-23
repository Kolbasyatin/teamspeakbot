-- Память статусов между рестартами бота (итерация 22). Без неё каждое обновление бота начинало
-- статусы серверов с unknown: подписчики получали «is online» по каждому серверу, а /status
-- показывал «онлайн уже 1 минуту».

-- Последний известный статус сервера и с какого момента он держится. Пишется на каждом переходе
-- и раз в MONITOR_STATE_SYNC_INTERVAL_MS (confirmed_at). При старте восстанавливается, только если
-- confirmed_at свежее MONITOR_STATE_RESTORE_MAX_AGE_MS: старое ничего не говорит о сейчас.
-- unknown не хранится. Миллисекунды — ради порядка записей, пришедших в одну секунду.
CREATE TABLE IF NOT EXISTS server_status_state
(
    server_id    bigint unsigned          not null
        primary key,
    status       enum ('online','offline') not null,
    status_since timestamp(3)             not null,
    confirmed_at timestamp(3)             not null,
    constraint fk_server_status_state_server
        foreign key (server_id) references monitored_servers (id)
            on delete cascade
);

-- Какой статус сервера последним доставлен в чат («is online» / «is offline»). Память
-- ChangesOnlyNotifier, которая раньше жила только в процессе. Строка на пару (чат, сервер):
-- новое значение перезаписывает старое — это ячейка, а не журнал событий.
-- delivered — тип события (serverOnline | serverOffline), строкой по той же причине, что event_kind.
CREATE TABLE IF NOT EXISTS telegram_status_deliveries
(
    chat_id      bigint                                not null,
    server_id    bigint unsigned                       not null,
    delivered    varchar(32)                           not null,
    delivered_at timestamp default current_timestamp() not null,
    primary key (chat_id, server_id),
    constraint fk_telegram_status_deliveries_chat
        foreign key (chat_id) references telegram_chats (chat_id)
            on delete cascade,
    constraint fk_telegram_status_deliveries_server
        foreign key (server_id) references monitored_servers (id)
            on delete cascade
);
