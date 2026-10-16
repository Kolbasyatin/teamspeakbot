-- Права на команды бота (rbac.md). Здесь лежит только НАЗНАЧЕНИЕ «этому чату выдана эта роль».
-- Что роль разрешает и какие роли в какие входят — в коде (src/access/Roles.ts): повседневно
-- меняется, кому выдана роль, а не её состав, и состав без выката меняться не должен.
--
-- Ключ — chat_id, как у подписок: выдал роль группе — ею пользуются все участники. Знаковый
-- bigint по той же причине, что в 005: у групп id отрицательные.
--
-- role — строка, а не enum: допустимые значения живут в коде, как query_type у источников
-- и event_kind у типов уведомлений. Иначе новая роль требовала бы миграции.
--
-- granted_by — кто выдал (user_id человека). NULL — выдал не человек: роль по умолчанию при /start
-- или назначение, перенесённое этой миграцией. Ссылки на telegram_chats нет намеренно: история
-- «кто выдал» не должна пропадать вместе с чатом выдавшего.
--
-- ROLE_ROOT здесь не хранится вовсе: он задаётся TELEGRAM_ROOT_CHAT_IDS, иначе неудачным
-- /revoke можно запереть себя навсегда.

CREATE TABLE IF NOT EXISTS telegram_chat_roles
(
    chat_id    bigint                                not null,
    role       varchar(64)                           not null,
    granted_by bigint                                null,
    granted_at timestamp default current_timestamp() not null,
    note       varchar(255)                          null,
    primary key (chat_id, role),
    constraint fk_telegram_chat_roles_chat
        foreign key (chat_id) references telegram_chats (chat_id)
            on delete cascade
);

-- Роль по умолчанию выдаётся при /start ОДИН раз за всю историю чата. Пометка «выдавали» —
-- отдельно от самого назначения: если бы выдача шла «когда ролей нет», то любой, у кого роль
-- отобрали, вернул бы её себе повторным /start.
ALTER TABLE telegram_chats
    ADD COLUMN IF NOT EXISTS default_role_granted_at timestamp null;

-- Чаты, которые пользовались ботом до появления прав, ничего не теряют: им выдаётся роль
-- по умолчанию, как если бы они только что нажали /start. Команды про игроков им при этом
-- НЕ выдаются — ради этого права и заводились; их раздаёт root.
INSERT IGNORE INTO telegram_chat_roles (chat_id, role, note)
SELECT chat_id, 'ROLE_SERVER_USER', 'миграция 009: чат был до появления прав'
FROM telegram_chats;

UPDATE telegram_chats
SET default_role_granted_at = current_timestamp()
WHERE default_role_granted_at IS NULL;
