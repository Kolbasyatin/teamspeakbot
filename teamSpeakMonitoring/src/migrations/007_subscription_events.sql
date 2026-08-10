-- Какие уведомления включены у подписки. Отдельной таблицей, а не колонкой: добавление нового типа
-- не требует миграции вообще — это строки, а не схема. SET потребовал бы ALTER на каждый тип,
-- JSON лишил бы проверок.
--
-- Подписка при этом остаётся тем же, чем была: «чат следит за сервером». Человек так и думает,
-- а внутри у неё набор того, что ему присылать.
--
-- event_kind хранится строкой, а не enum: enum — это тоже схема, и добавление значения снова
-- потребовало бы ALTER. Список допустимых значений живёт в коде (SubscriptionEventKind),
-- как и у query_type в server_query_sources.
--
-- ON DELETE CASCADE: набор типов без подписки не имеет смысла.
--
-- Существующим подпискам ниже проставляются ОБА типа. Умолчание такое, потому что человек
-- подписывается, чтобы знать, а не чтобы потом искать настройки. roundFinish на момент миграции
-- ещё никем не публикуется — он начнёт работать сам, когда появится детектор.

CREATE TABLE IF NOT EXISTS server_subscription_events
(
    subscription_id bigint unsigned                       not null,
    event_kind      varchar(32)                           not null,
    created_at      timestamp default current_timestamp() not null,
    primary key (subscription_id, event_kind),
    constraint fk_subscription_events_subscription
        foreign key (subscription_id) references server_subscriptions (id)
            on delete cascade
);

INSERT IGNORE INTO server_subscription_events (subscription_id, event_kind)
SELECT id, 'availability'
FROM server_subscriptions;

INSERT IGNORE INTO server_subscription_events (subscription_id, event_kind)
SELECT id, 'roundFinish'
FROM server_subscriptions;
