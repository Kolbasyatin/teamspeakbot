CREATE DATABASE IF NOT EXISTS tsbot
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON tsbot.* TO 'teamspeak'@'%';

FLUSH PRIVILEGES;

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