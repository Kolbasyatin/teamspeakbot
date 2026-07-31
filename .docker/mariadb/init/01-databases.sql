-- Провижининг баз, а не миграция схемы. Выполняется образом MariaDB один раз, при первой
-- инициализации тома (/docker-entrypoint-initdb.d), от root — поэтому GRANT здесь возможен.
--
-- Почему это отдельно от миграций: мигратор подключается к УЖЕ существующей базе и создать её
-- сам не может — курица и яйцо. Схему таблиц (monitored_servers и далее) создаёт мигратор,
-- здесь только сами базы и права.
--
-- Базу `teamspeak` (её использует TeamSpeak-сервер) создаёт сам образ по MARIADB_DATABASE,
-- вместе с пользователем из MARIADB_USER/MARIADB_PASSWORD. Ниже — то, чего образ не умеет:
-- дополнительные базы и права на них тому же пользователю.

CREATE DATABASE IF NOT EXISTS tsbot
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

-- Отдельная база для тестов: чтобы прогон с TRUNCATE не трогал данные разработки.
CREATE DATABASE IF NOT EXISTS tsbot_test
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON tsbot.* TO 'teamspeak'@'%';
GRANT ALL PRIVILEGES ON tsbot_test.* TO 'teamspeak'@'%';

FLUSH PRIVILEGES;
