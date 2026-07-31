# Рантайм в Docker

Два окружения, оба описаны здесь целиком, кроме чувствительных данных: их место занимают
`env/*.example`, а настоящие файлы гитигнорятся (`.docker/env/*.env`).

| файл | что |
|---|---|
| `compose.dev.yaml` | разработка: MariaDB, а под профилями — TeamSpeak и приложение |
| `compose.prod.yaml` | прод: TeamSpeak + MariaDB + образ приложения из GHCR |
| `mariadb/init/01-databases.sql` | провижининг баз `tsbot` и `tsbot_test` (не миграция схемы) |
| `Dockerfile` | образ для сервиса `app` из дев-compose (node + git), не для прода |
| `env/secrets.env.example` | пароли для подстановки в прод-compose |
| `env/tsbot.env.example` | конфигурация приложения |

Прод и дев **изолированы по построению**: разные имена проектов (`teamspeak6` против `tsbot-dev`)
и разные имена томов, поэтому дев-окружение не может подключиться к прод-данным или затереть их.

## Разработка

```bash
cd .docker
docker compose -f compose.dev.yaml up -d          # только MariaDB
```

Этого достаточно для обычной работы: приложение и тесты запускаются **на хосте**
(`npm run dev`, `npm test`) и находят базу по `localhost:3306` — ровно то, что прописано
в закоммиченных `.env` и `.env.test`. Пароли в дев-compose не секретные и совпадают с ними,
поэтому ничего настраивать не нужно.

При первой инициализации тома создаются три базы: `teamspeak` (её ведёт TeamSpeak-сервер),
`tsbot` (разработка) и `tsbot_test` (тесты). Скрипты из `mariadb/init` выполняются **только**
при первом создании тома. Если базы не появились — снести том и поднять заново:

```bash
docker compose -f compose.dev.yaml down
docker volume rm tsbot-dev-mariadb-data
docker compose -f compose.dev.yaml up -d
```

Профили — то, что нужно не всегда:

```bash
docker compose -f compose.dev.yaml --profile teamspeak up -d   # + TeamSpeak 6 на 10022
docker compose -f compose.dev.yaml --profile app up -d         # + приложение в контейнере
```

Для профилей `teamspeak` и `app`:
- TeamSpeak-сервер поднимается с ServerQuery-паролем `devquery`, то же значение нужно положить
  в `TS_PASSWORD` своего `.env.local`;
- сервису `app` нужен `env/tsbot.env` (скопировать из `env/tsbot.env.example`). Хосты БД
  и TeamSpeak compose подставит сам — внутри сети это имена сервисов, а не `localhost`.

## Прод

На машине нужны два файла, которых нет в репозитории:

```bash
cp env/secrets.env.example env/secrets.env      # пароли БД и ServerQuery
cp env/tsbot.env.example  env/tsbot.env         # конфигурация приложения
```

Запуск и обновление:

```bash
docker compose --env-file env/secrets.env -f compose.prod.yaml pull
docker compose --env-file env/secrets.env -f compose.prod.yaml up -d
```

`--env-file` обязателен: без него не подставятся `${TS_DB_PASSWORD}` и остальные пароли.

Образ приложения собирается отдельно — workflow `Build Docker Images` в GitHub Actions
(ручной запуск) и публикуется в GHCR.

### Схема БД

Мигратора пока нет: схема применяется вручную из `teamSpeakMonitoring/src/migrations/`.
Решение по мигратору принято (отдельная команда, отдельный процесс, вызов при деплое —
см. `PLAN.md`, «Принятые решения»), реализация — итерация 6b. Тогда в прод-compose появится
одноразовый сервис `migrate` и `depends_on: {migrate: {condition: service_completed_successfully}}`;
место под него помечено `TODO` в `compose.prod.yaml`.
