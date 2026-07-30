# tsbot

Daemon мониторинга серверов Arma Reforger. Опрашивает серверы (A2S / REST), держит их статус и публикует
сводку в описание каналов TeamSpeak, а переходы online/offline — в Telegram.

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

Полное описание — архитектура, конфигурация, схема БД, деплой, технический долг и планы —
в [`AGENTS.md`](../AGENTS.md) в корне репозитория.
