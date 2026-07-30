# AGENTS.md

Контекст проекта для агентов и людей. Единый источник правды по архитектуре, конфигурации и запуску.
`teamSpeakMonitoring/README.md` — короткая витрина, содержательное описание живёт здесь.

Текущие задачи, порядок работ и журнал сделанного — в [`PLAN.md`](PLAN.md). Работаем итерациями:
одна итерация = одна проблема, описанная по схеме «какую проблему решаем → в чём она состоит сейчас →
как решаем → к какому проверяемому результату это приводит».

## 1. Что это за приложение

`tsbot` (`teamSpeakMonitoring`) — долгоживущий daemon на Node.js/TypeScript. Он:

1. читает список игровых серверов (Arma Reforger) из MariaDB;
2. периодически опрашивает каждый сервер (A2S по UDP или REST);
3. держит in-memory состояние каждого сервера (`unknown` / `online` / `offline`) с антидребезгом по `failedChecks`;
4. при изменении сводного представления обновляет `channel_description` заданных каналов TeamSpeak (BBCode);
5. при переходах статуса online/offline пишет в Telegram-канал;
6. отвечает на команды Telegram-бота (`/time`, `/who`, `/id`);
7. поднимает внутренний admin HTTP endpoint для перечитывания списка серверов из БД без рестарта.

Окружение вокруг приложения (на prod-сервере, в одном compose): MariaDB, TeamSpeak 6 server, `tsbot-monitor`.

## 2. Структура репозитория

```
.docker/                     dev-контейнер (ТОЛЬКО локальная разработка)
  Dockerfile                 node:22-trixie + git, USER node, CMD bash
  docker-compose.yaml        монтирует ../teamSpeakMonitoring в /workspace
.github/workflows/
  docker-build.yml           workflow_dispatch → build & push ghcr.io/<repo>/tsbot-monitor
sinusbot.http                ручные HTTP-запросы (SinusBot API, admin endpoints, Telegram, armahq)
http-client.env.json         окружения для .http (prod/dev); приватные значения — в
                             http-client.private.env.json (gitignored)
teamSpeakMonitoring/         сам сервис
  Dockerfile                 prod-образ (multi-stage build → runtime, node dist/main.js)
  .env, .env.dev, .env.test  дефолты, коммитятся (без реальных секретов)
  .env.local, .env.*.local   реальные значения, gitignored
  src/
    main.ts                  composition root: собирает объекты, вешает подписки, shutdown
    properties.ts            convict-конфиги: TeamSpeak, DB, admin-порт, TG, monitor, TS-каналы
    notifierConfig.ts        convict-флаги включения нотифаеров
    logger.ts                pino (pino-pretty вне production)
    a2s/
      config.ts              ServerMonitorConfig, ServerQueryConfig (a2s | rest) + мёртвый пример
      ServerMonitor.ts       владеет probes, шедулит опрос, эмитит viewChanged/serverOnline/Offline
      ServerProbe.ts         состояние одного сервера, эмитит online/offline/playersChanged
      ProbeScheduler.ts      generic Scheduler<TTask>: per-task setTimeout, sync без сброса таймеров
      TeamSpeakRender.ts     ServerDescriptionView[] → BBCode-строка
    queriers/
      A2sQuerier.ts          @callowayisweird/source-query
      RestQuerier.ts         fetch + AbortController по timeout
    repositories/
      ServerRepository.ts    findAllEnabled(): читает monitored_servers, парсит query_config JSON
      ServerRepository.test.ts  интеграционный тест по живой MariaDB
    teamspeak/
      TeamSpeakConnection.ts жизненный цикл одного query-соединения (SSH), lazy connect, close
      TeamSpeakClient.ts     единственное место, знающее про ts3-nodejs-library API
    tg/
      TelegramBot.ts         grammy long-polling, команды бота
      TelegramSender.ts      отправка в канал
      TelegramOnlineHandler.ts / TelegramOfflineHandler.ts   NotificationHandler'ы
    Notifiers/
      Notifiers.ts           NotificationEvent, NotificationHandler, роутер Notifier
      TSNotifier.ts          пишет описание канала через ChannelDescriptionEditor
      LogNotifier.ts         пишет событие в лог
    server/AdminServer.ts    node:http, POST-роуты → события
    migrations/00_migration.sql  текущая схема (применяется вручную)
    test/databaseTestUtils.ts    migrate/truncate/fixture для тестов
    Saiga.ts                 клиент к OpenAI-совместимому API (Ollama). Пока не подключён — см. §9
```

## 3. Runtime-поток

```
                     ┌──────────────────┐
   MariaDB ──────────│ ServerRepository │
                     └────────┬─────────┘
                              │ findAllEnabled()
   POST /internal/            ▼
   reload-servers    ┌──────────────────┐   sync    ┌──────────────┐
   ─── AdminServer ─▶│  ServerMonitor   │──────────▶│  Scheduler   │
                     │  Map<id, Probe>  │◀──────────│ per-task     │
                     └──┬────────────┬──┘  run()    │ setTimeout   │
                        │            │              └──────────────┘
          Querier(a2s|rest)          │ probe.handleResult()
                        │            ▼
                        │      ┌───────────┐  online/offline
                        │      │ServerProbe│──────────┐
                        │      └───────────┘          │
                        ▼                             ▼
                 emitChangedIfNeeded()          ┌──────────┐
                   viewChanged ────────────────▶│ Notifier │ (роутинг по типу события)
                                                └────┬─────┘
                               statusViewChanged ─────┼──▶ TSNotifier ─▶ TeamSpeakClient ─▶ TS6
                                                      ├──▶ LogNotifier
                               serverOnline/Offline ───┴──▶ Telegram*Handler ─▶ TelegramSender ─▶ TG
```

Ключевые особенности:

- **Один probe = один сервер.** Статус определяется только фактом ответа. Успех → `online`, `failedChecks = 0`.
  Неудача → `failedChecks++`, и только при достижении `maxFailedChecks` статус становится `offline`.
- **Адаптивный интервал.** Если `failedChecks > 0` и статус ещё не `offline` — опрос учащается до
  `MONITOR_SUSPICIOUS_POLL_INTERVAL_MS` (борьба с ложными срабатываниями), иначе `MONITOR_POLL_INTERVAL_MS`.
- **Дедупликация вида.** `ServerMonitor` сравнивает `JSON.stringify(view)` с предыдущим и эмитит `viewChanged`
  только при отличии — чтобы не дёргать TeamSpeak на каждом poll.
- **Один query-коннект на процесс.** `TeamSpeakConnection` держит одно SSH-соединение; его делят `TSNotifier`
  (через `TeamSpeakClient`) и Telegram-команда `/who`. Закрывает его `main` при shutdown.
- **`syncServers` vs `forceSync`.** `syncServers` (`POST /internal/reload-servers`) добавляет/удаляет probes,
  не трогая существующие — их состояние и таймеры сохраняются. `forceSync`
  (`POST /internal/force-reload-servers`) пересоздаёт все probes — нужен, когда в БД поменялись поля
  существующей строки. Побочный эффект: состояние теряется, статусы заново проходят через `unknown`.

## 4. Границы модулей (что важно не нарушать)

Проект сознательно строится на узких интерфейсах, объявленных **на стороне потребителя**:

| Интерфейс | Где объявлен | Кто реализует | Смысл |
|---|---|---|---|
| `Querier` | `a2s/ServerMonitor.ts` | `A2sQuerier`, `RestQuerier` | монитор не знает про протоколы опроса |
| `ChannelDescriptionEditor` | `Notifiers/TSNotifier.ts` | `TeamSpeakClient` | нотифаер не знает про ts3-библиотеку и соединение |
| `StatusSource` | `tg/TelegramBot.ts` | `ServerMonitor` | боту нужен только `getSnapshot()` |
| `OnlineNicknamesSource` | `tg/TelegramBot.ts` | `TeamSpeakClient` | боту нужен только список ников |
| `NotificationHandler` | `Notifiers/Notifiers.ts` | `TSNotifier`, `LogNotifier`, `Telegram*Handler` | канал доставки заменяем |

Правила при доработках:

- Новый транспорт опроса → новый класс в `queriers/`, регистрация в `ServerMonitor.queriers`, новый вариант
  в `ServerQueryConfig`. Больше ничего менять не нужно.
- Новый канал уведомлений → класс, реализующий `NotificationHandler`, + регистрация в `Notifier`.
- Всё, что зависит от конкретной библиотеки, живёт в одном адаптере (`TeamSpeakClient`, `TelegramSender`,
  `*Querier`). Не протаскивать типы библиотек в домен (сейчас это нарушено — см. §8).
- Зависимости отдаются через конструктор из `main.ts`. Модуль не должен сам читать глобальный конфиг
  (сейчас это нарушено в `Notifier` — см. §8).

## 5. Конфигурация

Загрузка: `dotenv-flow` (`import "dotenv-flow/config"`) + `convict` со `validate({allowed: "strict"})` —
неизвестная переменная в схеме валит старт.

Порядок файлов: `.env` → `.env.<NODE_ENV>` → `.env.local` → `.env.<NODE_ENV>.local`.
`NODE_ENV=test` для тестов, `production` для prod-образа.

| Переменная | Дефолт | Назначение |
|---|---|---|
| `TS_HOST` | `127.0.0.1` | TeamSpeak host |
| `TS_PORT` | `10022` | query-порт (SSH-протокол, `QueryProtocol.SSH` зашит в код) |
| `TS_USERNAME` / `TS_PASSWORD` | `""` | server query креды |
| `TS_NOTIFY_CHANNELS` | `ServerInfo` | имена каналов через запятую (custom convict-формат) |
| `TEAMSPEAK_NOTIFIER` | `false` | вкл. обновление описания канала |
| `LOG_NOTIFIER` | `true` | вкл. вывод события в лог |
| `TELEGRAM_NOTIFIER` | `false` | вкл. Telegram-уведомления о статусах |
| `TELEGRAM_TOKEN` / `TELEGRAM_CHANNEL_ID` | `""` | бот и целевой чат |
| `DB_HOST` | `127.0.0.11` | MariaDB (в compose — имя сервиса, напр. `mariadb`) |
| `DB_PORT` | `3306` | |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `teamspeak` / `""` / `tsbot` | |
| `DB_CONNECTION_LIMIT` | `2` | размер пула |
| `SYNC_SERVER_PORT` | `3000` | порт admin HTTP (слушает `0.0.0.0`) |
| `MONITOR_POLL_INTERVAL_MS` | `5000` | обычный интервал опроса |
| `MONITOR_SUSPICIOUS_POLL_INTERVAL_MS` | `1000` | интервал после неудачной попытки |
| `MONITOR_MAX_FAILED_CHECKS` | `5` | сколько неудач до `offline` |

Секреты кладутся **только** в `*.local`-файлы (gitignored). Коммитятся `.env`, `.env.dev`, `.env.test`
как шаблоны с заглушками.

> Больное место: набор обязательных переменных для `.env.local` приходится каждый раз вспоминать.
> Планируется автоматизация (Makefile / генератор `.env.local` из схемы convict) — см. §9.

## 6. База данных

Единственная таблица — `monitored_servers`:

```sql
CREATE TABLE IF NOT EXISTS monitored_servers
(
    id           bigint unsigned auto_increment primary key,
    name         varchar(255)                           not null,
    game_address varchar(255)                           not null,  -- адрес для игроков, не для опроса
    query_type   varchar(32)                            not null,  -- 'a2s' | 'rest'
    query_config longtext collate utf8mb4_bin           not null
        check (json_valid(`query_config`)),                        -- ServerQueryConfig как JSON
    enabled      tinyint(1) default 1                   not null,
    created_at   timestamp  default current_timestamp() not null,
    updated_at   timestamp  default current_timestamp() not null on update current_timestamp()
);
```

`query_config` — сериализованный `ServerQueryConfig`, **включая поле `type`**; `ServerRepository`
проверяет, что оно совпадает с `query_type`, иначе бросает ошибку.

```sql
INSERT INTO monitored_servers (name, game_address, query_type, query_config, enabled)
VALUES ('#1 ARMA-RUSSIAN.RU', '37.48.253.41:2001', 'a2s',
        '{"type":"a2s","host":"37.48.253.41","port":17771,"timeout":5000}', TRUE);
```

После правки БД дёрнуть admin endpoint:

```bash
curl -X POST http://localhost:3000/internal/reload-servers        # добавили/удалили/выключили сервер
curl -X POST http://localhost:3000/internal/force-reload-servers  # изменили поля существующего сервера
```

**Миграции.** Сейчас `src/migrations/00_migration.sql` применяется руками, а схема для тестов
продублирована в `src/test/databaseTestUtils.ts` — два источника правды. Нужен настоящий мигратор
(версионированные миграции + применение при старте/командой + создание тестовой БД). Это запланированная
задача, а не «как задумано».

## 7. Сборка, запуск, деплой

### Локальная разработка

Два варианта — на хосте или в dev-контейнере из `.docker/`. Контейнер нужен, чтобы не зависеть от
локальной версии Node (образ `node:22-trixie`, рабочая директория `/workspace` смонтирована
на `teamSpeakMonitoring`, `CMD bash` — интерактивная оболочка, а не запуск сервиса):

```bash
docker compose -f .docker/docker-compose.yaml run --rm node bash
# внутри: npm install && npm run dev
```

`.docker/` **не используется для прода**. MariaDB и TeamSpeak в этот compose не входят — их нужно иметь
снаружи.

### Команды (из `teamSpeakMonitoring/`)

```bash
npm install
npm run dev        # tsx watch src/main.ts
npm run build      # tsc -p tsconfig.json → dist/
npm start          # node dist/main.js
npm test           # NODE_ENV=test, node:test через tsx
npm run test:repo  # только src/repositories/*.test.ts
```

### Prod

- `teamSpeakMonitoring/Dockerfile` — multi-stage: build (`npm ci` + `tsc`) → runtime (`npm ci --omit=dev`
  + `dist/`), `USER node`, `NODE_ENV=production`, `CMD node dist/main.js`.
- Сборка образа — GitHub Actions `docker-build.yml`, запуск **только вручную** (`workflow_dispatch`,
  input `service=monitor`). Публикует `ghcr.io/<repo>/tsbot-monitor:latest` и `:sha-<sha>`.
- На сервере лежит отдельный (пока не в этом репозитории) `docker-compose`, который поднимает MariaDB,
  TeamSpeak 6 server и `tsbot-monitor` из GHCR-образа. Prod-compose планируется добавить в репозиторий.
- CI не собирает и не тестирует код на push/PR — только собирает образ по кнопке.

## 8. Известный технический долг

Актуально для задач «развязать модули» — это то, что стоит трогать в первую очередь.

**Связность и слои**

1. `Notifier` (`Notifiers/Notifiers.ts`) сам конструирует все хендлеры и импортирует глобальные
   `notifierConfig`, `tgProperties`, `tsNotifierChannelNames`. Это service locator, а не DI: добавление
   нотифаера требует правки роутера, а протестировать `Notifier` изолированно нельзя. Композицию надо
   поднять в `main.ts`, а `Notifier` оставить чистым роутером `event type → handlers`.
2. Второй экземпляр grammy `Bot` создаётся внутри `Notifier` для `TelegramSender` — при том, что
   `TelegramBot` уже держит свой на том же токене. Один `Bot` должен создаваться в `main.ts` и отдаваться
   обоим.
3. Тип `ServerInfo` из `@callowayisweird/source-query` протёк через все слои (`ServerProbe`,
   `ServerMonitor`, snapshot'ы, и `RestQuerier` вынужден кастовать свой объект в чужой тип). Нужен
   собственный domain-тип результата опроса, а библиотечный оставить внутри `A2sQuerier`.
4. Интерфейс `Querier` объявлен в `a2s/ServerMonitor.ts`, поэтому `queriers/*` зависят от модуля монитора.
   Контракт стоит вынести в нейтральный модуль.
5. `queriers/*` делают непроверенный `config as A2sQueryConfig` / `as RestQueryConfig`. Работает только
   потому, что `ServerMonitor` выбирает querier по `type`. Стоит дискриминировать явно.
6. Папка `a2s/` содержит вещи, не относящиеся к A2S: `ServerMonitor`, `ProbeScheduler`, `config`,
   `TeamSpeakRender` (последний вообще принадлежит TeamSpeak-нотифаеру). Имя папки врёт.
7. Логирование двумя стилями: `ServerMonitor`, `ServerProbe`, `TeamSpeakConnection` получают `Logger`
   в конструктор, остальные восемь модулей импортируют глобальный `log`.
8. `Notifier.close()` — обвязка, оставшаяся от прошлой версии: дедупликация через `Set`,
   `Promise.allSettled`, логирование причин отказа, а все четыре `close()` под ней — `return;`.
   Исторически это был настоящий чистый выход из SSH-сессии: до коммита `3729d0a` `TSNotifier` владел
   соединением, и его `close()` делал `quit()` → ожидание события `close` → таймаут 10 с →
   `forceQuit()`. В том коммите блок перенесён дословно в `TeamSpeakConnection.close()`, владение
   ушло в `main.ts`, а обвязка осталась пустой. Ресурсами владеет `main.ts`, поэтому `close()` стоит
   убрать из интерфейса `NotificationHandler` целиком.
9. Маршрутизация событий выполняется дважды: `Notifier` роутит по `event.type` через `Map`, и каждый
   хендлер начинается с `if (event.type !== "...") return` — проверки, которая не может сработать.
   Плюс две событийные номенклатуры (события `ServerMonitor` и union `NotificationEvent`) с ручным
   адаптером между ними в `main.ts:26-45`. `emit`/`on` со строковыми именами компилятором не
   проверяются: опечатка = тихий no-op.

**Поведение и надёжность**

10. `Scheduler.runTask` вызывает `await task.run()` без `try/catch`. Любое исключение внутри run
   (включая обработчики событий, которые выполняются синхронно на `emit`) навсегда убивает
   перепланирование именно этой задачи — сервер молча перестанет опрашиваться.
11. `AdminServer` поддерживает bearer-токен, но `main.ts` передаёт только `port` — эндпоинты открыты
   без авторизации на `0.0.0.0:3000`. Токен нужно завести в convict и прокинуть, либо явно не публиковать
   порт наружу.
12. `emitChangedIfNeeded()` вызывается после каждого poll каждого probe: при N серверах вид пересчитывается
    и сериализуется N раз за цикл. Сравнение — через `JSON.stringify`.
13. `ServerProbe` эмитит `playersChanged` и `serverStatusChanged`, но подписчиков нет.
14. `forceSync` пересоздаёт probes, теряя `status`/`statusSince`/`failedChecks` — после него все серверы
    заново проходят `unknown → online` и Telegram получит повторные «is online».
15. `ServerProbe` конструктор: обязательный `logger` идёт после параметров с дефолтами.
16. `TeamSpeakRender` форматирует время жёстко в `Europe/Moscow` и вызывает `new Date()` внутри — это
    делает вид недетерминированным и нетестируемым.

**Инструментарий**

17. Нет мигратора (см. §6) и нет линтера/форматтера.
18. `src/test/databaseTestUtils.ts` импортирует `ServerQueryConfig` без `type` и без расширения `.js` —
    под NodeNext/`verbatimModuleSyntax` это невалидно, но не ловится, потому что тесты исключены из `tsc`
    и запускаются через `tsx`.
19. `.env.test` временно указывает на ту же БД `tsbot`, что и локальный прогон, а тесты делают
    `TRUNCATE`. Целевое состояние — отдельная локальная `tsbot_test`, создаваемая мигратором.

## 9. Планы

- **Мигратор БД** — версионированные миграции, отдельная тестовая БД, один источник правды по схеме.
- **Saiga / LLM (скоро).** `src/Saiga.ts` — уже написанный клиент к OpenAI-совместимому endpoint
  (Ollama, локальный GPU-хост, напр. `http://192.168.3.57:11434`), модель `ilyagusev/saiga_nemo_12b`.
  Замысел: генерировать короткие абсурдные русские тексты по событиям и постить в Telegram-канал,
  а дальше — озвучивать их и проигрывать в TeamSpeak через **SinusBot** (он сидит в канале TS6;
  API-запросы к нему — в `sinusbot.http`). Работы приостановлены, пока не работает GPU-сервер,
  но будут продолжены — это не мёртвый код.
- **Prod-compose в репозиторий** + автоматизация заполнения `.env.local` (Makefile или генератор),
  чтобы не вспоминать обязательные переменные вручную.
- Расширение функционала при сохранении развязанности модулей — основное архитектурное требование.

## 10. Соглашения по коду

- TypeScript strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
  `isolatedModules`. ESM, `module: NodeNext` → **относительные импорты обязательно с `.js`**
  (`./logger.js`), типы — через `import type`.
- Классы с зависимостями через конструктор; `private readonly` для полей.
- Event-driven связка через `node:events`; обработчики, передаваемые в `on`/`off`, объявляются как
  `private readonly handler = (…) => {}` (иначе `off` не снимет подписку).
- Комментарии в коде — на русском, короткие, объясняют «почему», а не «что». `FIXME`/`TODO` в коде
  оставлены осознанно.
- Ошибки в фоновых операциях гасятся на границе (`Promise.allSettled` в `Notifier`, `try/catch` в
  queriers) — падение одного канала доставки не должно ронять процесс.
- Graceful shutdown в `main.ts` на `SIGTERM`/`SIGINT`: monitor → notifier → telegram → teamspeak →
  admin server → db pool.
