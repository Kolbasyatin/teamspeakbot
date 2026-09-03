# tsbot

Daemon мониторинга серверов Arma Reforger. Опрашивает серверы (A2S, REST, каталог Bohemia), держит
их статус и публикует сводку в описание каналов TeamSpeak, а переходы online/offline — в Telegram.

```bash
npm install
npm run dev        # запуск в watch-режиме
npm run build      # сборка в dist/
npm start          # запуск собранного
npm test           # тесты (требуют MariaDB)
```

Список серверов хранится в MariaDB (`monitored_servers`). После правки БД:

```bash
curl -X POST http://localhost:3000/internal/reload-servers        # добавили/удалили сервер
curl -X POST http://localhost:3000/internal/force-reload-servers  # изменили существующий
```

## Очередь на вход: соседний сервис токенов Bohemia

Очередь, сценарий и код прямого подключения берутся из каталога Bohemia (источник `bohemia`
в `server_query_sources`). Для этого нужен BI access token, его добывает отдельный сервис
[`arma-reforger-hz`](https://github.com/kolbasyatin/arma-reforger-hz) и отдаёт по `GET /token`.
Без него всё работает как раньше, просто очередь не собирается.

**Дев.** Сосед поднимается в docker с портом на localhost (нужен `steam-auth.json` после логина через его CLI):

```bash
docker run -d --name arma-reforger-hz -p 127.0.0.1:8080:8080 -v /path/to/data:/data ghcr.io/kolbasyatin/arma-reforger-hz:latest
```

В **`.env.dev.local`** (гитигнорится) добавить:

```dotenv
BOHEMIA_TOKEN_URL=http://localhost:8080/token
```

**Прод.** Сервисы живут в разных compose и связаны внешней docker-сетью `arma-shared`:

1. `docker network create arma-shared` — один раз на машине (оба systemd-юнита делают это же в `ExecStartPre`).
2. В `.docker/env/tsbot.env` — `BOHEMIA_TOKEN_URL=http://arma-reforger-hz:8080/token`.
3. Обновить юниты `teamspeak6.service` и `arma-reforger.service` из репозиториев (`daemon-reload`, `restart`).

Подробности и остальные переменные `BOHEMIA_*` (User-Agent и версия клиента, меняются с патчами
игры) — [`AGENTS.md`](../AGENTS.md), §5, и [`.docker/README.md`](../.docker/README.md),
раздел «Соседний сервис».

Полное описание — архитектура, конфигурация, схема БД, деплой, технический долг и планы —
в [`AGENTS.md`](../AGENTS.md) в корне репозитория.
