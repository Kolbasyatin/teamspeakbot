-- Подписка на ИГРОКА: «этот чат хочет знать, когда этот человек заходит и выходит».
-- Пара к 006 (подписка на сервер) и устроена так же: chat_id ссылается на telegram_chats,
-- набор уведомлений по умолчанию не настраивается — появится потребность, появится и таблица,
-- как 007 появилась к 006.
--
-- player_id — идентификатор ЧУЖОГО сервиса (observer, репозиторий arma-players-backend).
-- Внешнего ключа нет и быть не может: игроки живут в другой базе, у другого владельца, и мы
-- о них знаем только по HTTP. Поэтому колонка — непрозрачное число, а не ссылка.
--
-- Подписка на ник невозможна: один ник носят разные люди (на 2026-09-11 таких ников 891),
-- и человек меняет ник, не переставая быть собой. Поэтому подписываются всегда на player_id,
-- а ник — только способ его найти.
--
-- Фильтра по серверу здесь нет намеренно: подписка означает «на любом отслеживаемом сервере».
-- «Только на этом сервере» — отдельный смысл, и колонка у него появится вместе с ним.
-- NULL в UNIQUE MariaDB считает различными значениями, так что колонку-фильтр нельзя завести
-- «про запас»: она молча разрешила бы дубли.

CREATE TABLE IF NOT EXISTS player_subscriptions
(
    id         bigint unsigned auto_increment
        primary key,
    chat_id    bigint                                not null,
    player_id  bigint unsigned                       not null,
    created_at timestamp default current_timestamp() not null,
    constraint uq_player_subscriptions_chat_player
        unique (chat_id, player_id),
    constraint fk_player_subscriptions_chat
        foreign key (chat_id) references telegram_chats (chat_id)
            on delete cascade
);

-- Отложенная подписка: человек назвал ник, а observer такого игрока ещё не видел.
-- Пустой ответ поиска не означает «игрока нет»: наблюдаются не все серверы Reforger, и отличить
-- опечатку от «играет вне выборки» нельзя. Поэтому ник запоминается, и бот периодически
-- переспрашивает поиск; нашёлся — строка превращается в обычную подписку и удаляется отсюда.
--
-- nickname хранится как есть, а сравнивается регистронезависимо — этим занимается collation
-- колонки (utf8mb4_general_ci по умолчанию), отдельной lower-копии не нужно.
--
-- expires_at, а не «живёт вечно»: ожидание без срока превращается в вечный источник запросов
-- к чужому сервису. Срок ставит приложение, БД про него ничего не решает.

CREATE TABLE IF NOT EXISTS pending_player_subscriptions
(
    id              bigint unsigned auto_increment
        primary key,
    chat_id         bigint                                not null,
    nickname        varchar(255)                          not null,
    created_at      timestamp default current_timestamp() not null,
    -- datetime, а не timestamp: значение лежит в БУДУЩЕМ, а timestamp в MariaDB заканчивается
    -- 2038 годом. Для created_at это неважно, для срока жизни — уже да.
    expires_at      datetime                              not null,
    constraint uq_pending_player_subscriptions_chat_nick
        unique (chat_id, nickname),
    constraint fk_pending_player_subscriptions_chat
        foreign key (chat_id) references telegram_chats (chat_id)
            on delete cascade
);

-- Курсор ленты событий observer: id последнего обработанного события. Одна строка на приложение,
-- поэтому первичный ключ — константа, а не auto_increment: вторая строка здесь была бы ошибкой,
-- и схема должна это запрещать, а не полагаться на аккуратность кода.
--
-- Курсор общий, а не по подписке: он означает «до этого места лента прочитана», и от состава
-- подписок не зависит. Подписался человек на кого-то в 21:00 — события до 21:00 уже позади,
-- истории он не получит, и это правильно: уведомление о входе, случившемся вчера, бесполезно.
--
-- Хранится в БД, а не в памяти: после перезапуска процесс обязан продолжить с того же места,
-- иначе пропущенные за время простоя входы и выходы теряются молча.

CREATE TABLE IF NOT EXISTS player_event_cursor
(
    id             tinyint unsigned                      not null default 1,
    last_event_id  bigint unsigned                       not null,
    updated_at     timestamp default current_timestamp() not null on update current_timestamp(),
    primary key (id),
    constraint ck_player_event_cursor_singleton check (id = 1)
);
