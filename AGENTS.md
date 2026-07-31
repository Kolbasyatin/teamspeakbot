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
    retry.ts                 повтор с экспоненциальным backoff
    Saiga.ts                 клиент к OpenAI-совместимому API (Ollama). Пока не подключён — см. §9

    monitoring/            ← домен: что значит «следить за сервером»
      ServerMonitor.ts       владеет probes, шедулит опрос, эмитит viewChanged/serverOnline/Offline;
                             здесь же ServerDescriptionView
      ServerProbe.ts         состояние одного сервера; ServerSnapshot, ServerStatus
      Scheduler.ts           generic Scheduler<TTask>: per-task setTimeout, sync без сброса таймеров
      MonitoredServer.ts     ServerMonitorConfig + шпаргалка по строке в monitored_servers
      ServerQuery.ts         контракт опроса: ServerQueryConfig (a2s | rest), ServerQueryResult,
                             интерфейс Querier
    notifications/         ← домен уведомлений + реализации каналов доставки
      events.ts              контракт: NotificationEvent, NotificationEventOf<T>, Notifier<T>,
                             NotificationSubscription и subscribe() — единственное место
                             с приведением типа события
      NotificationDispatcher.ts  раздаёт событие подписанным на его тип
      TeamSpeakChannelNotifier.ts  обновляет описание канала TeamSpeak; здесь же
                             ChannelDescriptionEditor
      LogNotifier.ts         пишет событие в лог
      LatestOnlyNotifier.ts  обёртка «последнее побеждает»: пока доставка идёт, промежуточные
                             события выбрасываются (coalescing)
      StateSync.ts           периодическая публикация текущего состояния (statusViewRefreshed);
                             здесь же CurrentStateSource и StatePublisher. Часов внутри нет —
                             когда тикать, решает Scheduler в composition root
      TelegramStatusNotifier.ts  переходы статуса в Telegram; текст — из таблицы
                             Record<событие, текст>; здесь же интерфейс MessageSender

    queriers/              ← адаптеры опроса
      A2sQuerier.ts          @callowayisweird/source-query (единственный, кто знает эту библиотеку)
      RestQuerier.ts         fetch + AbortController, проверка формы ответа
    teamspeak/             ← адаптер TeamSpeak
      TeamSpeakConnection.ts жизненный цикл одного query-соединения (SSH), lazy connect, close
      TeamSpeakClient.ts     единственное место, знающее про ts3-nodejs-library API
      ChannelDescriptionRenderer.ts  ServerDescriptionView[] → BBCode-строка описания канала
    telegram/              ← адаптер Telegram
      TelegramBot.ts         grammy long-polling, команды бота
      TelegramSender.ts      отправка текста в чат
    persistence/           ← адаптер БД
      ServerRepository.ts    findAllEnabled(): читает monitored_servers, парсит query_config JSON
      ServerRepository.test.ts  интеграционный тест по живой MariaDB
    admin/AdminServer.ts   ← адаптер HTTP: node:http, POST-роуты → события

    migrations/00_migration.sql  текущая схема (применяется вручную)
    test/databaseTestUtils.ts    migrate/truncate/fixture для тестов
```

Логика имён: **домен назван по задаче** (`monitoring`, `notifications`), **адаптеры — по тому, что они
адаптируют** (`queriers`, `teamspeak`, `telegram`, `persistence`, `admin`). Технология в имени остаётся
только там, где технология и есть суть.

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
                 emitChangedIfNeeded()   ┌────────────────────────┐
                   viewChanged ─────────▶│ NotificationDispatcher │ раздача по типу события
                                         └───────────┬────────────┘
                        statusViewChanged ───────────┼──▶ TeamSpeakChannelNotifier ─▶ TeamSpeakClient ─▶ TS6
                      statusViewRefreshed ───────────┤    (подписан на оба события с видом)
                                                     ├──▶ LogNotifier (только statusViewChanged)
                      serverOnline/Offline ──────────┴──▶ TelegramStatusNotifier ─▶ TelegramSender ─▶ TG

   Scheduler (свой,   ┌───────────┐  getView()   ┌───────────┐
   в composition ────▶│ StateSync │◀─────────────│ServerMonitor│
   root, 60 с)        └─────┬─────┘              └───────────┘
                            │ statusViewRefreshed
                            ▼  NotificationDispatcher
```

Ключевые особенности:

- **Один probe = один сервер.** Статус определяется только фактом ответа. Успех → `online`, `failedChecks = 0`.
  Неудача → `failedChecks++`, и только при достижении `maxFailedChecks` статус становится `offline`.
- **Адаптивный интервал.** Если `failedChecks > 0` и статус ещё не `offline` — опрос учащается до
  `MONITOR_SUSPICIOUS_POLL_INTERVAL_MS` (борьба с ложными срабатываниями), иначе `MONITOR_POLL_INTERVAL_MS`.
- **Дедупликация вида.** `ServerMonitor` сравнивает `JSON.stringify(view)` с предыдущим и эмитит `viewChanged`
  только при отличии — чтобы не дёргать TeamSpeak на каждом poll.
- **Склейка обновлений TeamSpeak.** `emitChangedIfNeeded()` вызывается после опроса каждого сервера,
  поэтому за цикл может уйти несколько `viewChanged`, и все — через `void`, без ожидания. Описание
  канала обёрнуто в `LatestOnlyNotifier`: пока запись идёт, новые события перезаписывают друг друга,
  и по завершении доставляется только самое свежее. В очереди никогда не больше одного обновления.
  Telegram **не** обёрнут: там каждое событие — самостоятельный факт.
- **Периодическая синхронизация состояния** (итерация 8a). Раз в `MONITOR_STATE_SYNC_INTERVAL_MS`
  отдельная задача в собственном `Scheduler` спрашивает у монитора текущий вид и публикует его
  событием `statusViewRefreshed`. Данные те же, что в `statusViewChanged`, но факт другой —
  «состояние переопубликовано без изменений», поэтому имя не врёт и журнал (`LogNotifier`)
  на него не подписан. Описание канала TeamSpeak переписывается безусловно: так лечится упавшая
  доставка (состояние может больше не меняться, и другого шанса не будет) и откатывается правка
  описания, сделанная в TeamSpeak руками. Первый тик уходит сразу на старте, поэтому сразу после
  рестарта в описании на один интервал опроса появятся статусы `unknown`.
- **Один query-коннект на процесс.** `TeamSpeakConnection` держит одно SSH-соединение; его делят `TeamSpeakChannelNotifier`
  (через `TeamSpeakClient`) и Telegram-команда `/who`. Закрывает его `main` при shutdown.
- **`syncServers` vs `forceSync`.** `syncServers` (`POST /internal/reload-servers`) добавляет/удаляет probes,
  не трогая существующие — их состояние и таймеры сохраняются. `forceSync`
  (`POST /internal/force-reload-servers`) пересоздаёт все probes — нужен, когда в БД поменялись поля
  существующей строки. Побочный эффект: состояние теряется, статусы заново проходят через `unknown`.

## 4. Границы модулей (что важно не нарушать)

Проект сознательно строится на узких интерфейсах, объявленных **на стороне потребителя**:

| Интерфейс | Где объявлен | Кто реализует | Смысл |
|---|---|---|---|
| `Querier` | `monitoring/ServerQuery.ts` | `A2sQuerier`, `RestQuerier` | монитор не знает про протоколы опроса; принимает `ServerQueryConfig`, отдаёт `ServerQueryResult` |
| `ChannelDescriptionEditor` | `notifications/TeamSpeakChannelNotifier.ts` | `TeamSpeakClient` | нотифаер не знает про ts3-библиотеку и соединение |
| `StatusSource` | `telegram/TelegramBot.ts` | `ServerMonitor` | боту нужен только `getSnapshot()` |
| `OnlineNicknamesSource` | `telegram/TelegramBot.ts` | `TeamSpeakClient` | боту нужен только список ников |
| `Notifier<TType>` | `notifications/events.ts` | `TeamSpeakChannelNotifier`, `LogNotifier`, `TelegramStatusNotifier` | канал доставки заменяем; `TType` — объединение обслуживаемых событий, любой ширины |
| `MessageSender` | `notifications/TelegramStatusNotifier.ts` | `TelegramSender` | нотифаеру нужна одна операция «отправить текст», про grammy и chatId он не знает |

Правила при доработках:

- Новый транспорт опроса → новый класс в `queriers/`, регистрация в `ServerMonitor.queriers`, новый вариант
  в `ServerQueryConfig`. Больше ничего менять не нужно.
- Новый канал уведомлений → класс, реализующий `Notifier`, плюс одна запись
  в списке `subscriptions` **в `main.ts`**. `NotificationDispatcher` при этом не меняется —
  он про конкретные каналы ничего не знает.
- Всё, что зависит от конкретной библиотеки, живёт в одном адаптере (`TeamSpeakClient`,
  `TelegramSender`, `*Querier`). Типы библиотек в домен не протаскиваются: querier обязан отдать
  доменный `ServerQueryResult`, а библиотечный тип оставить у себя. Проверяется командой
  `grep -rl "source-query" src/` — она должна находить только `A2sQuerier.ts`.
- **Ядро домена не импортирует адаптеры.** Проверяется командой:
  `grep -rn 'from "\.\./\(queriers\|teamspeak\|telegram\|persistence\|admin\)/' src/monitoring/ src/notifications/`
  — попадания допустимы только в нотифаерах уведомлений (см. §8, п. 21), в ядре их быть не должно.
- Зависимости отдаются через конструктор из `main.ts`. Модуль не должен сам читать глобальный конфиг.
  Единственные оставшиеся импорты из `properties.js` вне `main.ts` — это `import type` интерфейсов
  (`TeamSpeakProperties`, `MonitorProperties`): типы, а не синглтоны, значения по-прежнему инжектятся.

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
| `MONITOR_STATE_SYNC_INTERVAL_MS` | `60000` | период повторной публикации текущего состояния |

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
Нумерация сохраняется, закрытые пункты помечены (✅ / 🟡) и не удаляются: по ним видно, что уже
разобрано и почему. Ход работ — в [`PLAN.md`](PLAN.md).

**Связность и слои**

1. ✅ **Закрыто, итерация 2.** `Notifier` сам конструировал все нотифаеры и импортировал
   `notifierConfig`, `tgProperties`, `teamSpeakChannelNames` — service locator вместо DI. Композиция
   поднята в `main.ts`, класс переименован в `NotificationDispatcher` и стал чистым диспетчером
   `event type → handlers`; появились тесты.
2. ✅ **Закрыто, итерация 2.** Второй экземпляр grammy `Bot` создавался внутри `Notifier`
   для `TelegramSender`, хотя `TelegramBot` уже держал свой на том же токене. Теперь `Bot` создаётся
   один раз в `main.ts` (и только при непустом токене) и отдаётся обоим.
3. ✅ **Закрыто, итерация 3.** Тип `ServerInfo` из `@callowayisweird/source-query` протекал через
   все слои (`ServerProbe`, `ServerMonitor`, snapshot'ы), а `RestQuerier` кастовал свой объект
   в чужой тип. Введён доменный `ServerQueryResult`; библиотечный тип заперт в `A2sQuerier`
   (`grep -rl "source-query" src/` находит только его). Заодно вскрылось и починено: `RestQuerier`
   не проверял форму ответа, и `players: undefined` молча уезжал в домен.
4. ✅ **Закрыто, итерация 4.** Интерфейс `Querier` был объявлен в `ServerMonitor.ts`, из-за чего
   `queriers/*` зависели от модуля своего потребителя. Перенесён в `monitoring/ServerQuery.ts`,
   рядом с `ServerQueryConfig` и `ServerQueryResult`. Тем же движением вылечен такой же дефект
   в уведомлениях: контракт (`NotificationEvent`, `Notifier`, `NotificationSubscription`)
   вынесен из `NotificationDispatcher.ts` в `notifications/events.ts`, и нотифаеры больше
   не импортируют файл, названный по диспетчеру.
5. `queriers/*` делают непроверенный `config as A2sQueryConfig` / `as RestQueryConfig`. Работает только
   потому, что `ServerMonitor` выбирает querier по `type`. Стоит дискриминировать явно.
6. ✅ **Закрыто, итерация 4.** Папка `a2s/` содержала `ServerMonitor`, `ProbeScheduler`, `config`
   и `ChannelDescriptionRenderer` — ничего из этого к протоколу A2S не относится. Раскладка переделана:
   домен в `monitoring/` и `notifications/`, адаптеры в `queriers/`, `teamspeak/`, `telegram/`,
   `persistence/`, `admin/`. Мёртвый массив-пример `servers` удалён, вместо него — описание
   структуры строки `monitored_servers` в `MonitoredServer.ts`.
7. 🟡 **Частично, итерации 2 и 4a.** Логирование двумя стилями. `Logger` в конструктор получают
   `ServerMonitor`, `ServerProbe`, `TeamSpeakConnection`, `Scheduler`, `NotificationDispatcher`,
   `LogNotifier`, `A2sQuerier`, `RestQuerier`. Глобальный `log` остался в `TelegramBot`
   и `AdminServer` (плюс `main.ts`, где это уместно) — итерация 7.
8. ✅ **Закрыто, итерация 2:** `close()` убран из интерфейса `Notifier` целиком, вместе
   с обвязкой в диспетчере. Ресурсами владеет `main.ts`. История, чтобы не возвращаться к вопросу:
   `Notifier.close()` — обвязка, оставшаяся от прошлой версии: дедупликация через `Set`,
   `Promise.allSettled`, логирование причин отказа, а все четыре `close()` под ней — `return;`.
   Исторически это был настоящий чистый выход из SSH-сессии: до коммита `3729d0a` `TeamSpeakChannelNotifier` владел
   соединением, и его `close()` делал `quit()` → ожидание события `close` → таймаут 10 с →
   `forceQuit()`. В том коммите блок перенесён дословно в `TeamSpeakConnection.close()`, владение
   ушло в `main.ts`, а обвязка осталась пустой.
9. ✅ **Закрыто, итерация 5a.** Маршрутизация выполнялась дважды: диспетчер роутил по `event.type`,
   и каждый нотифаер начинался с `if (event.type !== "...") return`. Теперь `Notifier<TType>`
   параметризован типом события, `notify` получает уже суженное событие, защитных проверок нет.
   Подписки собираются функцией `subscribe()`, и несовпадение типа события с нотифаером —
   ошибка компиляции (проверено: TS2345). Две событийные номенклатуры **оставлены осознанно**:
   словарь монитора отдельный, чтобы `monitoring/` не знал про уведомления, а перевод делает
   composition root. Про предел типизации `EventEmitter` — п. 23.

20. ✅ **Закрыто, итерация 4a.** `ServerMonitor` сам создавал `new A2sQuerier()` и
    `new RestQuerier()`, из-за чего домен импортировал адаптеры, класс был непроверяем, а до queriers
    не доходила конфигурация. Теперь `QuerierRegistry` приходит из `main.ts`, queriers получают
    `Logger` в конструктор, у `ServerMonitor` появились тесты.

21. Хендлеры уведомлений лежат в `notifications/`, но по природе зависят от транспортов
    (`TeamSpeakChannelNotifier` → `teamspeak/ChannelDescriptionRenderer`; `TelegramStatusNotifier`
    зависимость на транспорт уже развязал интерфейсом `MessageSender`).
    То есть `notifications/` — не чистый домен: там и ядро (`events`, `NotificationDispatcher`),
    и адаптеры к транспортам. Альтернатива — держать каждый нотифаер рядом с его транспортом.
    Решение отложено до итерации 5, где у нотифаеров появится явная политика и станет видно,
    что в них домен, а что транспорт.

**Поведение и надёжность**

10. ✅ **Закрыто, итерация 0.** `Scheduler.runTask` вызывал `await task.run()` без `try/catch`,
    и любое исключение навсегда убивало перепланирование задачи — сервер молча выпадал
    из мониторинга. Теперь исключение логируется, перепланирование идёт по любому пути,
    `getNextDelayMs()` тоже под защитой с fallback-задержкой. Зафиксировано тестами.
11. `AdminServer` поддерживает bearer-токен, но `main.ts` передаёт только `port` — эндпоинты открыты
   без авторизации на `0.0.0.0:3000`. Токен нужно завести в convict и прокинуть, либо явно не публиковать
   порт наружу.
12. 🟡 **Частично, итерация 5b.** `emitChangedIfNeeded()` вызывается после каждого poll каждого probe:
    при N серверах вид пересчитывается и сериализуется N раз за цикл. Сравнение — через
    `JSON.stringify`. Сама лишняя работа осталась; закрыто её **последствие** — обновления TeamSpeak
    больше не копятся очередью, за это отвечает `LatestOnlyNotifier`.
13. ✅ **Закрыто, итерация 5a.** `ServerProbe` эмитил `playersChanged` и `serverStatusChanged`
    без единого подписчика. Оба удалены вместе с типом `ServerStatusEvent` — тем самым, о котором
    в коде стоял комментарий «зачем собирать сообщение чтоб потом из него забирать одно поле».
    У probe осталось ровно два события — переходы статуса. Изменение числа игроков наружу отдаёт
    `ServerMonitor` через `viewChanged`.
14. `forceSync` пересоздаёт probes, теряя `status`/`statusSince`/`failedChecks` — после него все серверы
    заново проходят `unknown → online` и Telegram получит повторные «is online».
15. `ServerProbe` конструктор: обязательный `logger` идёт после параметров с дефолтами.
16. `ChannelDescriptionRenderer` форматирует время жёстко в `Europe/Moscow` и вызывает `new Date()` внутри — это
    делает вид недетерминированным и нетестируемым.

**Инструментарий**

17. Нет мигратора (см. §6) и нет линтера/форматтера.
24. 🟡 **Частично, итерация 8a. Потеря доставки не восстанавливается.** Один корень: обновление
    уходило только в момент **изменения** состояния, повторять упавшую доставку было некому.

    **TeamSpeak — закрыто.** `StateSync` раз в `MONITOR_STATE_SYNC_INTERVAL_MS` публикует текущий
    вид событием `statusViewRefreshed`, и описание канала перезаписывается безусловно. Воспроизводимый
    сценарий (все серверы ушли в offline → TeamSpeak в этот момент недоступен → доставка упала →
    накопленное состояние выброшено → состояние больше не меняется → в описании навсегда «online 12/64»)
    теперь заканчивается записью на следующем тике; зафиксировано тестом `StateSync.test.ts`.
    Заодно откатывается правка описания, сделанная в TeamSpeak руками, и лечится возврат TeamSpeak
    после долгой недоступности. Предупреждение `Pending notification dropped after delivery failure`
    в `LatestOnlyNotifier` остаётся — потеря по-прежнему реальна, просто теперь у неё есть починка.
    Повтор с backoff внутри обёртки рассматривался и отклонён: он закрывает только короткий сбой,
    а главный сценарий (состояние больше не меняется) — нет.

    **Telegram — открыто, итерация 8b.** `serverOnline` эмитится только на переходе статуса, поэтому
    упавшая отправка «сервер онлайн» теряется до следующего падения и подъёма того же сервера.
    Безусловная периодическая отправка здесь недопустима: канал Telegram — журнал, а не табло, из неё
    получится 1440 сообщений «is online» в сутки. Лечение: тик публикует ещё и статусы серверов,
    а перед Telegram встаёт обёртка «сравни с последним **успешно доставленным**» (ключ — сервер плюс
    его статус); серверы в `unknown` пропускаются. См. «Следующий шаг» в [`PLAN.md`](PLAN.md).

    **Остаток п. 12 не снят.** Идея «эмитить вид после каждого опроса станет незачем» пока не
    реализована: `emitChangedIfNeeded()` по-прежнему вызывается после каждого probe. Периодический
    тик делает мгновенную реакцию на изменение необязательной, но убирать её — отдельное решение
    (оно ухудшит время реакции с «сразу» до «до минуты»).
23. Типизация `EventEmitter<T>` из Node проверяет **типы аргументов** `emit` и listener'а,
    но **не имена событий**: для незнакомого имени `Args<>` откатывается на `any[]`, поэтому
    `monitor.on("viewChangd", ...)` компилируется и остаётся тихим no-op. Сузить переопределением
    `on()` не выходит — сигнатура становится несовместимой с базовой (TS2416, проверено).
    Рабочий вариант, если понадобится: не наследовать `EventEmitter`, а обернуть его в типизированный
    фасад. Пока не делаем: ошибки в типах аргументов ловятся, а имён событий в проекте шесть.
22. Тесты исключены из `tsc` (`exclude` в `tsconfig.json`), поэтому **не проходят проверку типов**.
    Рефакторинг может сломать тест молча — обнаружится только на прогоне. Так и случилось в итерации
    4a: после добавления обязательного `Logger` в конструктор querier'а вызов `new RestQuerier()`
    в тесте остался без аргумента, и `tsc` этого не увидел. Лечится отдельным `tsconfig.test.json`,
    включающим тесты, и прогоном `tsc` по нему в проверках.
18. ✅ **Закрыто, итерация 1.** `src/test/databaseTestUtils.ts` импортировал `ServerQueryConfig`
    без `type` и без расширения `.js` — под NodeNext/`verbatimModuleSyntax` невалидно, но не ловилось,
    т.к. тесты исключены из `tsc`. Там же закрыто: `npm test` находил 0 тестов и рапортовал успех
    (Node 20 не подхватывает `.ts` по дефолтным шаблонам) — добавлен явный glob и скрипт `test:unit`.
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
- **Именование нотифаеров.** Имя несёт **место доставки** (`LogNotifier`,
  `TeamSpeakChannelNotifier`), а событие добавляется в имя только когда для одного места
  их несколько. Причина: событие уже
  написано явно в списке подписок в `main.ts`, дублировать его без нужды не стоит. Суффикс
  у всех один — `Notifier`, как у интерфейса: по имени должно быть видно, что они одного вида
  и взаимозаменяемы для диспетчера. Новый канал (например, озвучка через SinusBot) →
  `SinusBotVoiceNotifier`.
- **Сколько классов на сколько событий.** `Notifier<TType>` принимает объединение любой ширины:
  одно событие, несколько, все (`Notifier<NotificationEventType>`). Поэтому один класс на событие
  никто не требует, и выбор такой:
  разные **транспорты** → разные классы (у них разные зависимости, это не выбор);
  один транспорт, но разная **логика доставки** (другой адресат, форматирование, свой rate limit)
  → разные классы;
  один транспорт, отличается только **текст или данные** → один класс плюс таблица
  `Record<событие, ...>` (пример — `TelegramStatusNotifier`). `Record` заставляет компилятор
  требовать запись для каждого события, поэтому забыть новую строку нельзя.
- Event-driven связка через `node:events`; обработчики, передаваемые в `on`/`off`, объявляются как
  `private readonly handler = (…) => {}` (иначе `off` не снимет подписку).
- Комментарии в коде — на русском, короткие, объясняют «почему», а не «что». `FIXME`/`TODO` в коде
  оставлены осознанно.
- Ошибки в фоновых операциях гасятся на границе (`Promise.allSettled` в `NotificationDispatcher`, `try/catch` в
  queriers) — падение одного канала доставки не должно ронять процесс.
- Graceful shutdown в `main.ts` на `SIGTERM`/`SIGINT`: monitor → notifier → telegram → teamspeak →
  admin server → db pool.
