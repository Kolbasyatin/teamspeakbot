-- Развязка серверов и источников опроса: у одного сервера их теперь несколько.
--
-- Зачем: часть данных достаётся только из другого протокола. A2S отдаёт players/maxPlayers,
-- но не знает длины очереди; REST может её отдать, но лежать сам по себе при живом игровом сервере.
-- До этой миграции строка monitored_servers несла ровно один query_type + query_config,
-- то есть схема утверждала «источник один» — и parse сверял эти две колонки между собой.
--
-- role и priority — РАЗНЫЕ оси, схлопывать в одну колонку нельзя:
--   role     — кто определяет online/offline. Надёжность как индикатора жизни.
--   priority — кто выигрывает при слиянии данных, если поле пришло от нескольких источников.
-- Ровно поэтому нужны обе: статус берём у надёжного A2S, а players — у REST, стоящего выше
-- по приоритету данных. Меньшее число priority = важнее.
--
-- enabled на источнике отключает его, не удаляя строку, — как enabled на самом сервере.
-- Отключение primary НЕ требует руками переназначать роль другому: если включённого primary нет,
-- главным становится самый приоритетный из включённых. Это правило живёт в коде
-- (resolvePrimarySource), а не в схеме: БД не должна знать, кто сегодня главный.
--
-- Дроп старых колонок вынесен в 003 намеренно. DDL в MariaDB не транзакционный, поэтому
-- миграции держим мелкими: если ALTER упадёт, перенос данных уже будет позади и повторять
-- его не придётся.

CREATE TABLE IF NOT EXISTS server_query_sources
(
    id           bigint unsigned auto_increment
        primary key,
    server_id    bigint unsigned                        not null,
    role         enum ('primary','secondary')           not null,
    priority     int        default 0                   not null,
    query_type   varchar(32)                            not null,
    query_config longtext collate utf8mb4_bin           not null
        check (json_valid(`query_config`)),
    enabled      tinyint(1) default 1                   not null,
    created_at   timestamp  default current_timestamp() not null,
    updated_at   timestamp  default current_timestamp() not null on update current_timestamp(),
    constraint fk_server_query_sources_server
        foreign key (server_id) references monitored_servers (id)
            on delete cascade
);

-- Существующие серверы переезжают как есть: их единственный источник становится главным.
-- WHERE NOT EXISTS делает вставку идемпотентной — упавшая после CREATE миграция повторится
-- следующим запуском и не продублирует источники.
INSERT INTO server_query_sources (server_id, role, priority, query_type, query_config)
SELECT server.id,
       'primary',
       0,
       server.query_type,
       server.query_config
FROM monitored_servers server
WHERE NOT EXISTS (SELECT 1
                  FROM server_query_sources existing
                  WHERE existing.server_id = server.id);
