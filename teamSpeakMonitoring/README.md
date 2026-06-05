# tsbot

`tsbot` мониторит серверы Arma Reforger через A2S и публикует короткую сводку статуса в описание каналов TeamSpeak.

Сервис хранит список отслеживаемых серверов в MariaDB, опрашивает все включенные серверы, рендерит информацию о
статусе/игроках и обновляет настроенные notifiers только тогда, когда итоговое представление изменилось.

## Что Делает

- Загружает включенные серверы из MariaDB.
- Опрашивает каждый сервер через A2S.
- Отслеживает состояние сервера: `unknown`, `online`, `offline`.
- Рендерит TeamSpeak BBCode-блок со статусом, количеством игроков и временем последнего обновления.
- Отправляет итоговое описание в активные notifiers:
    - обновление описания TeamSpeak-канала;
    - вывод в лог.
- Поднимает внутренний HTTP endpoint для синхронизации списка серверов в `ServerMonitor` из БД без рестарта процесса.

## Как Работает

При старте:

1. Конфигурация загружается через `dotenv-flow` и `convict`.
2. Создается pool подключений к MariaDB.
3. `ServerRepository.findAllEnabled()` загружает включенные серверы из `monitored_servers`.
4. `ServerMonitor.syncServers()` создает runtime probes для этих серверов.
5. `ServerMonitor.start()` запускает polling.
6. Когда итоговое view изменилось, `Notify` отправляет новое описание в активные notifiers.

Во время работы:

- `ServerMonitor` опрашивает текущий набор probes каждые 5 секунд.
- `ServerProbe` хранит состояние одного сервера.
- `ServerMonitor` владеет коллекцией probes и эмитит `viewChanged`.
- `ServerDescriptionRenderer` превращает view в TeamSpeak BBCode.
- `Notify` отправляет сообщение во все активные notifiers.

## Хранение Серверов

Серверы хранятся в таблице MariaDB `monitored_servers`.

Текущая схема:

```sql
CREATE TABLE IF NOT EXISTS monitored_servers (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    game_address VARCHAR(255) NOT NULL,
    a2s_host VARCHAR(255) NOT NULL,
    a2s_port INT UNSIGNED NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
);
```

`ServerRepository` преобразует DB-поля в `snake_case` в TypeScript-объекты `ServerData` с `camelCase`.

## Добавление Серверов

Добавить сервер можно через insert в `monitored_servers`:

```sql
INSERT INTO monitored_servers
    (name, game_address, a2s_host, a2s_port, enabled)
VALUES
    ('#1 ARMA-RUSSIAN.RU', '37.48.253.41:2001', '37.48.253.41', 17771, TRUE);
```

После добавления нужно дернуть синхронизацию монитора:

```bash
curl -X POST http://localhost:3000/internal/reload-servers
```

Если admin endpoint защищен токеном:

```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  http://localhost:3000/internal/reload-servers
```

Reload endpoint только синхронизирует runtime-список серверов в `ServerMonitor`. Следующий плановый poll получит
A2S-данные и отправит новое описание, если итоговое view изменится.

## Обновление Серверов

Изменить сервер можно напрямую в MariaDB:

```sql
UPDATE monitored_servers
SET name = '#1 NEW NAME',
    a2s_host = '37.48.253.41',
    a2s_port = 17771,
    enabled = TRUE
WHERE id = 1;
```

После этого вызвать:

```bash
curl -X POST http://localhost:3000/internal/reload-servers
```

Чтобы отключить мониторинг без удаления строки:

```sql
UPDATE monitored_servers
SET enabled = FALSE
WHERE id = 1;
```

После этого также нужно вызвать reload endpoint.

## Конфигурация

Environment-файлы загружаются через `dotenv-flow`.

Типичные файлы:

- `.env` для значений по умолчанию.
- `.env.local` для локального запуска приложения.
- `.env.test` / `.env.test.local` для тестов с `NODE_ENV=test`.

Основные переменные:

```env
TS_HOST=127.0.0.1
TS_USERNAME=serveradmin
TS_PASSWORD=secret

TEAMSPEAK_NOTIFIER=true
LOG_NOTIFIER=true

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=teamspeak
DB_PASSWORD=secret
DB_NAME=tsbot
DB_CONNECTION_LIMIT=2
```

В Docker Compose `DB_HOST` обычно должен быть именем сервиса, например `mariadb`, а `DB_PORT` должен быть `3306`.

## Команды

Установить зависимости:

```bash
npm install
```

Запуск в development-режиме:

```bash
npm run dev
```

Сборка:

```bash
npm run build
```

Запуск собранного приложения:

```bash
npm start
```

Запуск тестов:

```bash
npm test
```

Запуск тестов repository:

```bash
npm run test:repo
```

## Заметки

- A2S не отдает размер очереди Arma Reforger. Сейчас renderer использует статус и количество игроков из A2S.
- TeamSpeak использует BBCode-подобную разметку, а не terminal escape-коды.
- TeamSpeak notifier при shutdown закрывает query-соединение через `quit()`.
- Admin HTTP server сейчас слушает `0.0.0.0:3000`.
