-- Первая миграция: таблица отслеживаемых серверов.
--
-- CREATE DATABASE и GRANT из прежнего 00_migration.sql здесь намеренно НЕТ: это провижининг,
-- он переехал в .docker/mariadb/init/01-databases.sql. Мигратор подключается к уже существующей
-- базе и создать её сам не может.
--
-- IF NOT EXISTS оставлено осознанно: DDL в MariaDB не транзакционный, поэтому упавшая посередине
-- миграция не откатывается, и повторный запуск должен быть безопасным.

CREATE TABLE IF NOT EXISTS monitored_servers
(
    id           bigint unsigned auto_increment
        primary key,
    name         varchar(255)                           not null,
    game_address varchar(255)                           not null,
    query_type   varchar(32)                            not null,
    query_config longtext collate utf8mb4_bin           not null
        check (json_valid(`query_config`)),
    enabled      tinyint(1) default 1                   not null,
    created_at   timestamp  default current_timestamp() not null,
    updated_at   timestamp  default current_timestamp() not null on update current_timestamp()
)
