-- Подписка: «этот чат хочет знать про этот сервер». Из неё выводится ВСЁ остальное —
-- и кому отправлять уведомление, и кого вообще опрашивать.
--
-- Отдельной миграцией от 005 по той же причине, по которой разделены 002 и 003: DDL в MariaDB
-- не транзакционный, поэтому миграции держим мелкими. Здесь это ещё и обязательно по порядку —
-- внешний ключ ссылается на таблицу из 005.
--
-- Колонки subscriber_type НЕТ и не планируется. Вид подписчика ровно один — чат Telegram.
-- TeamSpeak-табло вторым видом не является: оно показывает подписки одного конкретного чата
-- (того, что сегодня лежит в TELEGRAM_CHANNEL_ID), то есть окно в уже существующие строки,
-- а не собственный подписчик. См. telegram.md, §5.3.
--
-- UNIQUE (server_id, chat_id) делает подписку идемпотентной: повторное нажатие кнопки
-- «подписаться» не создаёт второй строки, а значит и второго сообщения при падении сервера.
--
-- updated_at здесь нет намеренно: подписку не редактируют, её заводят и удаляют. Появится
-- настройка (какие события слать, «не беспокоить до») — появится и колонка, вместе со своим смыслом.
--
-- Отдельный индекс по chat_id не нужен: MariaDB создаёт его сама под внешний ключ, и он же
-- обслуживает запрос «мои подписки». Пара (server_id, chat_id) из UNIQUE закрывает обратный
-- вопрос — «кто подписан на этот сервер».
--
-- ON DELETE CASCADE с обеих сторон: подписка не имеет смысла без любой из своих сторон.
-- Удалили сервер из каталога или чат — их подписки уходят следом, без осиротевших строк.

CREATE TABLE IF NOT EXISTS server_subscriptions
(
    id         bigint unsigned auto_increment
        primary key,
    server_id  bigint unsigned                       not null,
    chat_id    bigint                                not null,
    created_at timestamp default current_timestamp() not null,
    constraint uq_server_subscriptions_server_chat
        unique (server_id, chat_id),
    constraint fk_server_subscriptions_server
        foreign key (server_id) references monitored_servers (id)
            on delete cascade,
    constraint fk_server_subscriptions_chat
        foreign key (chat_id) references telegram_chats (chat_id)
            on delete cascade
)
