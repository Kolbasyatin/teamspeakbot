# AGENTS.md

Контекст проекта для агентов и людей. Единый источник правды по архитектуре, конфигурации и запуску.
`teamSpeakMonitoring/README.md` — короткая витрина, содержательное описание живёт здесь.

Текущие задачи, порядок работ и журнал сделанного — в [`PLAN.md`](PLAN.md). Работаем итерациями:
одна итерация = одна проблема, описанная по схеме «какую проблему решаем → в чём она состоит сейчас →
как решаем → к какому проверяемому результату это приводит».

## 1. Что это за приложение

`tsbot` (`teamSpeakMonitoring`) — долгоживущий daemon на Node.js/TypeScript. Он:

1. читает список игровых серверов (Arma Reforger) из MariaDB;
2. периодически опрашивает каждый сервер (A2S по UDP, REST, каталог серверов Bohemia);
3. держит in-memory состояние каждого сервера (`unknown` / `online` / `offline`) с антидребезгом по `failedChecks`;
4. при изменении сводного представления обновляет `channel_description` заданных каналов TeamSpeak (BBCode);
5. при переходах статуса online/offline пишет в Telegram-канал;
6. отвечает на команды Telegram-бота (`/time`, `/who`, `/id`);
7. поднимает внутренний admin HTTP endpoint для перечитывания списка серверов из БД без рестарта.

Окружение вокруг приложения (на prod-сервере, в одном compose): MariaDB, TeamSpeak 6 server, `tsbot-monitor`.

## 2. Структура репозитория

```
.docker/                     окружения целиком: дев и прод. См. .docker/README.md
  compose.dev.yaml           дев: MariaDB, под профилями teamspeak и app; своё имя проекта и тома
  compose.prod.yaml          прод: TeamSpeak 6 + MariaDB + tsbot-monitor из GHCR
  mariadb/init/01-databases.sql  провижининг баз tsbot и tsbot_test (не миграция схемы)
  env/*.env.example          шаблоны конфигов; настоящие *.env гитигнорятся
  Dockerfile                 node:22-trixie + git — образ для дев-сервиса app
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
    migrate.ts               вторая точка входа: применяет миграции и выходит (отдельный процесс)
    properties.ts            convict-конфиги: TeamSpeak, DB, admin-порт, TG, monitor, TS-каналы, Bohemia
    notifierConfig.ts        convict-флаги включения нотифаеров
    logger.ts                pino (pino-pretty вне production)
    retry.ts                 повтор с экспоненциальным backoff
    Saiga.ts                 клиент к OpenAI-совместимому API (Ollama). Пока не подключён — см. §9

    monitoring/            ← домен: что значит «следить за сервером»
      ServerMonitor.ts       владеет probes, шедулит опрос, эмитит stateUpdated (после каждого
                             опроса, безусловно) и serverOnline/Offline (переходы статуса)
      ServerProbe.ts         состояние одного сервера; ServerProbeSnapshot, ServerStatus
      Scheduler.ts           generic Scheduler<TTask>: per-task setTimeout, sync без сброса таймеров
      MonitoredServer.ts     StoredServer (контракт хранилища), ServerMonitorConfig,
                             ServerQuerySource, ServerQueryRole
                             + шпаргалка по строкам в monitored_servers/server_query_sources
      ServerQuery.ts         контракт опроса: ServerQueryConfig (a2s | rest | bohemia), ServerQueryResult
                             (все поля опциональные: players, очередь, сценарий, свежесть),
                             ServerPollResult (alive + info), Querier, QueryFieldMap;
                             SERVER_QUERY_FIELDS — доменные поля и их типы как значение, нужен
                             для проверки карт из БД и чужого JSON; narrowQueryConfig — сужение
                             конфига до типа querier'а (закрыт долг п. 5)
      pollServerSources.ts   опрос всех источников сервера за тик: параллельный старт, ожидание
                             главного, окно graceMs для остальных, слияние; здесь же SourceQueryRunner
      mergeQueryResults.ts   чистая функция: ответы источников → один результат, по приоритету
                             (списка полей нет: ключи приезжают вместе с данными)
      SecondarySourceThrottle.ts  второстепенные не чаще MONITOR_SECONDARY_POLL_INTERVAL_MS:
                             тик один, между опросами в слияние идёт прошлый ответ источника
      resolvePrimarySource.ts  чистая функция: кто из источников определяет online/offline
      buildMonitorConfigs.ts   StoredServer[] → ServerMonitorConfig[]: сортировка источников,
                             выбор главного, отсев серверов без источников; о пропусках
                             и подменах сообщает BuildNotice[], логирует их composition root
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
      StateSync.ts           периодическая публикация текущего состояния: состояние событием
                             serverStateRepublished, статусы серверов обычными serverOnline/Offline
                             (unknown пропускается). Здесь же CurrentStateSource и StatePublisher.
                             Часов внутри нет — когда тикать, решает Scheduler в composition root
      ChangesOnlyNotifier.ts обёртка «только при расхождении»: помнит последнюю УСПЕШНУЮ доставку
                             по каждому предмету и молчит, если состояние то же. Упавшая доставка
                             не запоминается и повторяется следующим тиком
      TelegramStatusNotifier.ts  переходы статуса в Telegram; текст — из таблицы
                             Record<событие, текст>; здесь же интерфейс MessageSender
      PerSubscriberNotifier.ts  обёртка «каждому подписчику своё»: одно событие про сервер →
                             доставка каждому подписчику, у каждого своя цепочка и своя память
                             дедупликации. Транспорта не знает; здесь же SubscriberSource
      SubscribedOnlyNotifier.ts  обёртка-фильтр: оставляет в событии только снапшоты серверов
                             своего чата. Ставится СНАРУЖИ ChangesOnlyNotifier — иначе чужой
                             сервер попадает в ключ дедупликации табло
      RoundFinishNotifier.ts текст сигнала «похоже, раунд заканчивается». Без дедупликации:
                             повторов не бывает, а запоздалый повтор врал бы

    rounds/                ← домен: «похоже, раунд заканчивается»
      PlayerHistory.ts       короткая история числа игроков за интерфейсом; в памяти для детектора,
                             персистентная реализация понадобится графикам
      detectRoundFinish.ts   чистое правило: окно замеров + текущее значение → вердикт.
                             Пороги проверены на двух сутках прод-логов, см. telegram.md §11
      RoundFinishWatcher.ts  потребитель serverStateUpdated и источник события roundFinish.
                             Дополнительного опроса не делает — игроки из того же события

    queriers/              ← адаптеры опроса
      A2sQuerier.ts          @callowayisweird/source-query (единственный, кто знает эту библиотеку)
      RestQuerier.ts         разбор любого JSON по карте полей из конфига (пути с точкой,
                             поле за полем, тип значения — по SERVER_QUERY_FIELDS)
      BohemiaLobbyQuerier.ts POST rooms/search каталога Bohemia по hostAddress: очередь, сценарий,
                             код прямого подключения, свежесть. Единственный, кто знает форму
                             ответа Bohemia. Протокольные константы — из env (BOHEMIA_*)
      BiTokenProvider.ts     клиент к соседнему сервису arma-reforger-hz (GET /token): кэш до
                             expiresAt, один in-flight запрос на все серверы, invalidate по 401/403.
                             Пустой BOHEMIA_TOKEN_URL — источники bohemia молчат
      fetchJson.ts           общий fetch с таймаутом для REST и Bohemia
    teamspeak/             ← адаптер TeamSpeak
      TeamSpeakConnection.ts жизненный цикл одного query-соединения (SSH), lazy connect, close
      TeamSpeakClient.ts     единственное место, знающее про ts3-nodejs-library API
      ChannelDescriptionRenderer.ts  ServerProbeSnapshot[] → BBCode-строка описания канала.
                             render() — с отметкой времени (в канал), renderBody() — без неё
                             (ключ дедупликации). Проекция снапшота в строки живёт здесь
    telegram/              ← адаптер Telegram
      TelegramBot.ts         единственный владелец всего телеграмного: Bot, наборы команд, sender,
                             меню, start/stop, bot.catch. Здесь же интерфейс BotCommands с двумя
                             обязательными методами — register(bot) и describe() (подсказки для
                             setMyCommands; обязателен, чтобы новый набор не выпал из меню молча).
                             ВХОДЯЩЕЕ (команды, кнопки) работает только после start() — это запуск
                             long polling; ИСХОДЯЩЕЕ (sender) работает всегда, sendMessage полингу
                             не подчинён. Без bot.catch ошибка в обработчике гасит polling целиком
      TeamSpeakCommands.ts   всё, что бот умеет про TeamSpeak: пока только /who; здесь же
                             OnlineNicknamesSource. Раньше назывался StatusCommands и держал
                             ещё /time (уехал синонимом /status — показывал чужие подписки)
                             и /id (удалён, был отладочным)
      TelegramSender.ts      отправка текста: send(chatId, text). Один на процесс — лимит Bot API
                             (~30 сообщений/сек) общий на бота, поэтому и очередь будет здесь
      TelegramChat.ts        TelegramChat, TelegramChatType — контракт хранилища для подписчика
                             (по той же причине, что StoredServer лежит в monitoring/)
      SubscriptionCommands.ts  /start, /serverlist, /my, /status и обработка нажатий. Кнопки
                             разводятся регистрацией (bot.callbackQuery по шаблону), а действия
                             внутри — таблицами Record; здесь же ServerCatalog, SubscriptionStore
                             и StatusSource — узкие интерфейсы к зависимостям
      SubscriptionEvent.ts   типы уведомлений подписки: availability, roundFinish. Здесь же подписи
                             для кнопок и умолчания — второго списка, который может разъехаться,
                             не появляется
      ServerCardMessage.ts   карточка сервера: галочки по типам, отписка. Своё пространство кодов
                             callback_data, не пересекающееся со списком
      ServerListMessage.ts   текст и клавиатура списка чистой функцией + кодирование/разбор
                             callback_data (коды в Record, а не в тернарниках: забытое действие
                             валит сборку). Без grammy-контекста, проверяется без сети
      ServerStatusMessage.ts сводка «мои серверы» для /status. Момент времени — параметром,
                             поэтому текст детерминирован
    persistence/           ← адаптер БД
      ServerRepository.ts    findMonitored(): читает monitored_servers + server_query_sources
                             и отдаёт StoredServer[] — только включённые и только те, на которые
                             есть хотя бы одна подписка. Доменных решений не принимает
                             findCatalogPage/countCatalog/findByIds — каталог для бота: ВСЕ включённые
                             серверы, в том числе без подписок (иначе подписаться было бы не на что)
      SubscriptionRepository.ts  чтение и запись подписок: чаты, подписка/отписка, типы уведомлений
                             и обе стороны связи — «на что подписан чат» и «кто подписан на сервер
                             вот на этот тип»
      parseQueryConfig.ts    чистая функция разбора query_config (вся содержательная логика
                             persistence); проверяется в test:unit, без БД
      Migrator.ts            применяет недостающие миграции; здесь же контракт MigrationStore
      MariaDbMigrationStore.ts  реализация контракта на mariadb: таблица schema_migrations
      migrationFiles.ts      чтение каталога миграций, разбор имён NNN_имя.sql, контрольные суммы
      ServerRepository.test.ts       интеграционный тест по живой MariaDB
      SubscriptionRepository.test.ts то же для подписок: хранение, идемпотентность, каскады
    admin/AdminServer.ts   ← адаптер HTTP: node:http, POST-роуты → события

    migrations/NNN_*.sql         миграции, применяются по возрастанию номера
    test/databaseTestUtils.ts    миграция тестовой БД тем же мигратором, очистка, фикстуры;
                             assertTestDatabase — предохранитель по имени базы
    test/serverFixtures.ts       serverConfigFixture(): готовый ServerMonitorConfig для тестов,
                             которым состав источников безразличен
```

Логика имён: **домен назван по задаче** (`monitoring`, `notifications`), **адаптеры — по тому, что они
адаптируют** (`queriers`, `teamspeak`, `telegram`, `persistence`, `admin`). Технология в имени остаётся
только там, где технология и есть суть.

## 3. Runtime-поток

```
                     ┌──────────────────┐   StoredServer[]   ┌──────────────────────┐
   MariaDB ──────────│ ServerRepository │───────────────────▶│ buildMonitorConfigs  │
                     └──────────────────┘  только чтение     │ порядок, главный,    │
                        findMonitored(): enabled + подписка   │ отсев + notices      │
                                                             └──────────┬───────────┘
   POST /internal/                          ServerMonitorConfig[]       ▼
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
                 emit(снапшоты всех)     ┌────────────────────────┐
                   stateUpdated ────────▶│ NotificationDispatcher │ раздача по типу события
                                         └───────────┬────────────┘
                         serverStateUpdated ─────────┼──▶ SubscribedOnly(серверы чата-владельца)
                                                     │      └▶ ChangesOnly(по тексту описания)
                                                     │          └▶ LatestOnly ─▶ TeamSpeakChannelNotifier ─▶ TS6
                      serverStateRepublished ────────┼──▶ SubscribedOnly ─▶ LatestOnly ─▶ тот же нотифаер,
                                                     │                                    МИМО дедупликации
                                                     ├──▶ ChangesOnlyNotifier(по выжимке) ─▶ LogNotifier
                      serverOnline/Offline ──────────┴──▶ PerSubscriber(кто подписан на сервер)
                                                            └▶ на КАЖДОГО: ChangesOnly ─▶ TelegramStatusNotifier
                                                               (своя память у каждого чата: отказ одному
                                                                не заставляет повторять всем)

   Scheduler (свой,   ┌───────────┐       getSnapshot()         ┌─────────────┐
   в composition ────▶│ StateSync │◀────────────────────────────│ServerMonitor│
   root, 60 с)        └─────┬─────┘                             └─────────────┘
                            │ serverStateRepublished + serverOnline/Offline по каждому серверу
                            ▼  NotificationDispatcher
```

Ключевые особенности:

- **Один probe = один сервер.** Статус определяется только фактом ответа **главного** источника.
  Успех → `online`, `failedChecks = 0`. Неудача → `failedChecks++`, и только при достижении
  `maxFailedChecks` статус становится `offline`. Молчание второстепенного источника на статус
  не влияет вовсе — оно означает «поле неизвестно», а не «сервер лёг».
- **Опрос источников за тик** (`pollServerSources`). Все источники сервера стартуют одновременно,
  у каждого свой `timeout` внутри `query_config`. Дальше ждём только главного; как только он
  ответил, второстепенным даётся `MONITOR_SECONDARY_GRACE_MS` — кто не успел, в слиянии этого тика
  не участвует. Окно отсчитывается **от ответа главного**, иначе быстрые второстепенные съедали бы
  его бюджет. Главный промолчал — не ждём никого. Потолок тика = `timeout(главного) + grace`,
  и он важен: `Scheduler` планирует следующий тик после завершения предыдущего, поэтому без потолка
  один медленный источник растягивал бы интервал опроса всему серверу.
- **Второстепенные реже главного** (`SecondarySourceThrottle`). Второстепенный источник не
  опрашивается чаще `MONITOR_SECONDARY_POLL_INTERVAL_MS`; в тики между опросами в слияние идёт его
  прошлый ответ (иначе очередь мигала бы в табло). Тик при этом один и целостный: шедулер про это
  не знает, grace-окно работает как прежде. Висящий запрос на следующем тике не дублируется, а
  ошибка забывается сразу, чтобы повтор был возможен. Интервал — нижняя граница, а не расписание:
  при главном раз в 40 с и пороге 30 с второстепенный опрашивается каждый тик. Ноль выключает.
- **Адаптивный интервал.** Если `failedChecks > 0` и статус ещё не `offline` — опрос учащается до
  `MONITOR_SUSPICIOUS_POLL_INTERVAL_MS` (борьба с ложными срабатываниями), иначе `MONITOR_POLL_INTERVAL_MS`.
- **Дедупликация — у потребителя, не в мониторе.** Монитор эмитит `stateUpdated` после каждого опроса,
  безусловно, и отдаёт сырые снапшоты. Что считать изменением, решает каждый потребитель сам,
  обёрткой `ChangesOnlyNotifier`: описание канала сравнивает **отрендеренный текст без отметки
  времени** (`ChannelDescriptionRenderer.renderBody`), журнал — свою выжимку (`summarizeForLog`).
  Так и должно быть: у них разные представления о том, что важно, и поле, которого нет в описании,
  записи в TeamSpeak больше не вызывает. До этого монитор проецировал состояние в пять полей
  описания канала и сравнивал их — то есть знал форму чужого вывода.
- **Склейка обновлений TeamSpeak.** `stateUpdated` уходит после опроса каждого сервера,
  поэтому за цикл их несколько, и все — через `void`, без ожидания. Описание
  канала обёрнуто в `LatestOnlyNotifier`: пока запись идёт, новые события перезаписывают друг друга,
  и по завершении доставляется только самое свежее. В очереди никогда не больше одного обновления.
  Telegram **не** обёрнут: там каждое событие — самостоятельный факт.
- **Периодическая синхронизация состояния** (итерации 8a, 8b). Раз в `MONITOR_STATE_SYNC_INTERVAL_MS`
  отдельная задача в собственном `Scheduler` спрашивает у монитора текущее состояние и публикует его.
  Смысл один — «упавшую доставку должен кто-то повторить», — но каналы разной природы, поэтому
  механика для них разная:
  - **состояние → TeamSpeak, безусловно.** Событие `serverStateRepublished`: данные те же, что
    в `serverStateUpdated`, но факт другой — «публикуется принудительно». Тип и есть тот признак,
    по которому потребитель отличает «можно промолчать» от «перезаписать вопреки всему»: подписка
    на него идёт **мимо** `ChangesOnlyNotifier`. Иначе правку описания, сделанную в TeamSpeak
    руками, мы не откатили бы никогда — у себя-то состояние не менялось. Журнал на это событие
    не подписан: писать состояние целиком каждую минуту незачем.
  - **статусы серверов → Telegram, только при расхождении.** Публикуются обычные
    `serverOnline`/`serverOffline` по каждому серверу (`unknown` пропускается: сказать нечего),
    а решение «отправлять или молчать» принимает `ChangesOnlyNotifier`, сравнивая с последней
    **успешной** доставкой по этому серверу. Канал Telegram — журнал, безусловная отправка дала бы
    1440 сообщений «is online» в сутки.
  - **Обёртка Telegram — один экземпляр на оба события.** Двумя разными память разъезжается:
    обёртка «online» продолжала бы считать, что online уже доставлен, хотя между ними был offline.
  - Первый тик уходит сразу на старте, поэтому сразу после рестарта в описании канала на один
    интервал опроса появятся статусы `unknown`. Память `ChangesOnlyNotifier` живёт в процессе,
    поэтому после рестарта статусы отправятся заново — то же самое делает переход
    `unknown → online` на первом опросе (см. долг, п. 14).
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

- Новый транспорт опроса → новый вариант в `ServerQueryConfig`, класс в `queriers/` (первой строкой
  `narrowQueryConfig(config, "<type>")`), регистрация в реестре в `main.ts` — компилятор потребует её сам.
  Если у конфига есть обязательные поля, ветка в `parseQueryConfig`. Больше ничего менять не нужно:
  так и заводился `bohemia`.
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
| `TELEGRAM_TOKEN` / `TELEGRAM_CHANNEL_ID` | `""` | бот и **владелец табло TeamSpeak**: адресатов уведомлений задают подписки, а этот чат определяет, чьи подписки показывает описание канала. Не число (пусто или `@username`) — владельца нет, табло пустое, в лог `warn` |
| `DB_HOST` | `127.0.0.11` | MariaDB (в compose — имя сервиса, напр. `mariadb`) |
| `DB_PORT` | `3306` | |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `teamspeak` / `""` / `tsbot` | |
| `DB_CONNECTION_LIMIT` | `2` | размер пула |
| `SYNC_SERVER_PORT` | `3000` | порт admin HTTP (слушает `0.0.0.0`) |
| `MONITOR_POLL_INTERVAL_MS` | `5000` | обычный интервал опроса |
| `MONITOR_SUSPICIOUS_POLL_INTERVAL_MS` | `1000` | интервал после неудачной попытки |
| `MONITOR_MAX_FAILED_CHECKS` | `5` | сколько неудач до `offline` |
| `MONITOR_SECONDARY_GRACE_MS` | `1000` | сколько ждать второстепенные источники **после** ответа главного |
| `MONITOR_SECONDARY_POLL_INTERVAL_MS` | `30000` | не чаще какого интервала опрашивать один второстепенный источник; между опросами берётся его прошлый ответ. `0` — каждый тик |
| `BOHEMIA_TOKEN_URL` | `""` | `GET /token` соседнего сервиса arma-reforger-hz (в проде `http://arma-reforger-hz:8080/token` через общую docker-сеть). Пусто — источники `bohemia` молчат, остальное работает |
| `BOHEMIA_TOKEN_TIMEOUT_MS` / `BOHEMIA_TOKEN_REFRESH_LEAD_MS` | `3000` / `60000` | таймаут запроса токена; за сколько до `expiresAt` перезапрашивать |
| `BOHEMIA_LOBBY_URL` | `…/lobby/rooms/search` | эндпоинт каталога Bohemia |
| `BOHEMIA_USER_AGENT` / `BOHEMIA_CLIENT_VERSION` | `Arma Reforger/1.8.0.10 (Client; Windows)` / `1.8.0` | протокольные константы игрового клиента, **меняются с патчами игры** |
| `BOHEMIA_PLATFORM_ID` / `BOHEMIA_GAME_CLIENT_TYPE` | `ReforgerSteam` / `PLATFORM_PC` | поля тела запроса rooms/search |
| `MONITOR_STATE_SYNC_INTERVAL_MS` | `60000` | период повторной публикации текущего состояния |

Секреты кладутся **только** в `*.local`-файлы (gitignored). Коммитятся `.env`, `.env.dev`, `.env.test`
как шаблоны с заглушками.

> Больное место: набор обязательных переменных для `.env.local` приходится каждый раз вспоминать.
> Планируется автоматизация (Makefile / генератор `.env.local` из схемы convict) — см. §9.

## 6. База данных

Четыре таблицы, двумя парами. **Что мониторим** — сервер и его источники опроса
(`monitored_servers`, `server_query_sources`). **Кому это нужно** — чат Telegram и его подписки
(`telegram_chats`, `server_subscriptions`, миграции 005–006).

До миграции 002 таблица была одна, и колонки `query_type` / `query_config` лежали прямо
в `monitored_servers` — то есть схема утверждала, что источник у сервера ровно один.

```sql
CREATE TABLE IF NOT EXISTS monitored_servers
(
    id           bigint unsigned auto_increment primary key,
    name         varchar(255)                           not null,
    game_address varchar(255)                           not null,  -- адрес для игроков, не для опроса
    enabled      tinyint(1) default 1                   not null,
    created_at   timestamp  default current_timestamp() not null,
    updated_at   timestamp  default current_timestamp() not null on update current_timestamp()
);

CREATE TABLE IF NOT EXISTS server_query_sources
(
    id           bigint unsigned auto_increment primary key,
    server_id    bigint unsigned                        not null,  -- → monitored_servers.id, ON DELETE CASCADE
    role         enum ('primary','secondary')           not null,  -- primary решает online/offline
    priority     int        default 0                   not null,  -- меньше — важнее; порядок слияния
    query_type   varchar(32)                            not null,  -- 'a2s' | 'rest' | 'bohemia'
    query_config longtext collate utf8mb4_bin           not null
        check (json_valid(`query_config`)),                        -- ServerQueryConfig как JSON
    enabled      tinyint(1) default 1                   not null,  -- отключает источник, не сервер
    created_at   timestamp  default current_timestamp() not null,
    updated_at   timestamp  default current_timestamp() not null on update current_timestamp()
);
```

`query_config` — сериализованный `ServerQueryConfig`, **включая поле `type`**; `parseQueryConfig`
проверяет, что оно совпадает с `query_type`, иначе бросает ошибку.

У `rest`-источника в `query_config` обязателен **`fields` — карта полей**: ключ доменное имя,
значение путь в ответе с точкой как разделителем.

```json
{"type":"rest","url":"https://e.com/api","timeout":5000,
 "fields":{"players":"data.online","maxPlayers":"data.capacity"}}
```

Она нужна потому, что REST — это не протокол, а «любой HTTP с любым JSON»: имена полей у каждого
эндпоинта свои, и угадывать их нельзя. У `a2s` карты нет и быть не может — там форма ответа задана
протоколом. Опечатка в ключе карты роняет чтение конфига (`Unknown query fields [...]`): это
единственная поломка конфига, которая иначе не проявилась бы ничем — источник настроен, эндпоинт
отвечает, а поле просто никогда не читается. Список допустимых имён — `SERVER_QUERY_FIELDS`
в `ServerQuery.ts`, единственное место, где доменные поля перечислены как значение: тип в рантайме
не существует, сверять карту иначе не с чем.

У `bohemia`-источника собственное поле одно — `hostAddress`, игровой адрес сервера (тот же, что
`game_address`), по нему сервер ищется в каталоге Bohemia. Карты нет: протокол фиксирован.
Всё протокольное (URL, User-Agent, версии, токен) одинаково для всех серверов и лежит в env.

```json
{"type":"bohemia","hostAddress":"37.48.253.41:2001","timeout":5000}
```

`role` и `priority` — **разные оси**, схлопывать в одну колонку нельзя: `role` про надёжность
источника как индикатора жизни, `priority` про то, чьи данные выигрывают при слиянии. Рабочая
раскладка для Arma Reforger (решение zalex 2026-09-03): `a2s` — `primary`, `priority 0`; `bohemia` —
`secondary`, `priority 1`. Игроки всегда от A2S: он отвечает прямо с игрового сервера на каждом
опросе, а каталог Bohemia отстаёт на heartbeat. Bohemia приносит только то, чего A2S не знает:
очередь, сценарий, код прямого подключения. Делать `bohemia` главным не стоит: доступность каталога
и токена никак не связана с жизнью игрового сервера.

Отключить можно любой источник, включая `primary`: главным станет самый приоритетный из оставшихся
включённых (предупреждение в лог). Сервер, у которого не осталось ни одного включённого источника,
пропускается — probe для него не создаётся, иначе он копил бы неудачи и уехал в `offline`,
хотя опроса не было.

Оба правила применяет `buildMonitorConfigs` в домене, а не репозиторий: **хранилище отбирает
(`WHERE`), но ничего не выводит из прочитанного.** Поэтому замена MariaDB на SQLite — это новая
реализация чтения, отдающая тот же `StoredServer[]`, и ничего сверх того.

> **Живое доказательство, зачем нужен мигратор (найдено 2026-07-31).** Схема описана в двух местах,
> и вторая копия — в `src/test/databaseTestUtils.ts` — успела **разъехаться и сломаться**: там
> `primary key` был объявлен дважды (в колонке и отдельной строкой `PRIMARY KEY (id)`), а MariaDB
> отвергает это ошибкой `ER_MULTIPLE_PRI_KEY`. Дефект не проявлялся, потому что `CREATE TABLE
> IF NOT EXISTS` на уже существующей таблице ничего не делает: на локальной базе, где таблица была
> создана из первой миграции, тест проходил. На **чистой** базе интеграционный тест не работал
> никогда. Обнаружено при первом запуске тестов против свежего дев-окружения; лишняя строка убрана.
> Настоящая починка — один исполняемый источник схемы: мигратор появился в 6b, дубль DDL в тестах
> уходит в 6c.

### Подписчики и подписки (миграции 005–006)

```sql
CREATE TABLE IF NOT EXISTS telegram_chats
(
    chat_id    bigint                                          not null primary key,  -- ЗНАКОВЫЙ, см. ниже
    type       enum ('private','group','supergroup','channel') not null,  -- как в chat.type у Bot API
    title      varchar(255)                                    null,      -- для групп и каналов
    created_at timestamp default current_timestamp()           not null,
    updated_at timestamp default current_timestamp()           not null on update current_timestamp()
);

CREATE TABLE IF NOT EXISTS server_subscriptions
(
    id         bigint unsigned auto_increment primary key,
    server_id  bigint unsigned                       not null,  -- → monitored_servers.id, ON DELETE CASCADE
    chat_id    bigint                                not null,  -- → telegram_chats.chat_id, ON DELETE CASCADE
    created_at timestamp default current_timestamp() not null,
    UNIQUE (server_id, chat_id)
);

CREATE TABLE IF NOT EXISTS server_subscription_events
(
    subscription_id bigint unsigned                       not null,  -- → server_subscriptions.id, ON DELETE CASCADE
    event_kind      varchar(32)                           not null,  -- 'availability' | 'roundFinish'
    created_at      timestamp default current_timestamp() not null,
    primary key (subscription_id, event_kind)
);
```

**Типы уведомлений — отдельной таблицей, а не колонкой** (миграция 007). Добавление типа тогда
не требует миграции вообще: это строки, а не схема. `SET` потребовал бы `ALTER` на каждый новый тип,
JSON лишил бы проверок. `event_kind` строкой, а не `enum`, по той же причине — список допустимых
значений живёт в коде (`SubscriptionEventKind`), как и `query_type` у источников опроса.

Подписка при этом остаётся тем же, чем была, — «чат следит за сервером»; внутри у неё набор того,
что присылать. Рассылка спрашивает **«кто подписан на сервер вот на этот тип»**: следить за сервером
и хотеть знать про каждый конец раунда — разные вещи.

При создании подписки включаются **оба** типа, и только при создании: повторный `subscribe`
не должен возвращать галочки, которые человек снял.

**Подписчик — чат, а не пользователь.** Bot API адресует сообщения по `chat_id`: для лички он равен
`user_id`, для группы и канала это отдельное число. Возьми ключом `user_id` — и подписка группы
не выражается вовсе либо требует второй таблицы и второго пути доставки. С `chat_id` личка, группа
и канал из `TELEGRAM_CHANNEL_ID` — одна сущность с разным значением `type`.

**`chat_id` знаковый и без `auto_increment`.** У групп и каналов id отрицательные
(`-1001234567890`), поэтому `unsigned` сломал бы ровно тот случай, ради которого таблица заведена;
ключ выдаёт Telegram, а не мы. Закреплено тестом в `SubscriptionRepository.test.ts`.

**Колонки `subscriber_type` нет и не планируется.** Вид подписчика ровно один. TeamSpeak-табло
вторым видом не является: оно показывает подписки одного конкретного чата (того, что лежит
в `TELEGRAM_CHANNEL_ID`), то есть окно в уже существующие строки. См. `telegram.md`, §5.3.

**`UNIQUE (server_id, chat_id)` — не украшение, а идемпотентность подписки:** двойной тап
по кнопке «подписаться» не создаёт второй строки, а значит и второго сообщения при падении сервера.
Репозиторий опирается именно на это ограничение, а не на `SELECT` перед вставкой: проверка перед
вставкой не атомарна, и два одновременных нажатия её обходят.

**Отдельного индекса по `chat_id` нет** — MariaDB создаёт его сама под внешний ключ, и он же
обслуживает запрос «мои подписки». Обратный вопрос («кто подписан на этот сервер») закрывает
`UNIQUE`.

**`updated_at` у подписки нет намеренно:** её заводят и удаляют, но не редактируют. Появится
настройка (какие события слать, «не беспокоить до») — появится и колонка вместе со своим смыслом.

**`blocked_at` в `telegram_chats` пока нет,** хотя понадобится: её пишет только отправка сообщений
(403 «bot was blocked by the user»), а адресной отправки ещё не существует. Заводится вместе
со своим писателем.

### Подписка определяет, кого опрашивать

`ServerRepository.findMonitored()` отбирает серверы по **двум** условиям: `enabled = 1`
и наличие хотя бы одной подписки. Вопросы за ними разные и схлопывать их нельзя:

- `enabled` — «виден ли сервер в каталоге», то есть можно ли на него подписаться;
- подписка — «нужен ли он кому-то прямо сейчас».

Отсюда главное свойство: **каталог из тысячи серверов при трёх подписках даёт три опроса,
а не тысячу.** Отписался последний подписчик — сервер выпадает из опроса при следующей
пересборке списка (`POST /internal/reload-servers`).

Условие подписки стоит **в обоих запросах** — и по серверам, и по источникам: источники читаются
отдельным запросом, поэтому без него приехали бы источники серверов, которых в выдаче нет.
`EXISTS`, а не `JOIN`: сервер с десятью подписчиками обязан приехать одной строкой, иначе получил бы
десять probe.

### Заведение сервера руками

```sql
INSERT INTO monitored_servers (name, game_address, enabled)
VALUES ('#1 ARMA-RUSSIAN.RU', '37.48.253.41:2001', TRUE);

INSERT INTO server_query_sources (server_id, role, priority, query_type, query_config, enabled)
VALUES (LAST_INSERT_ID(), 'primary', 0, 'a2s',
        '{"type":"a2s","host":"37.48.253.41","port":17771,"timeout":5000}', TRUE);
```

**Одного сервера мало — на него должен быть подписан хотя бы один чат**, иначе он не опрашивается.
Подписать канал, который сегодня задан в `TELEGRAM_CHANNEL_ID`:

```sql
-- 1. Канал как обычный подписчик. chat_id взять из TELEGRAM_CHANNEL_ID (у каналов он отрицательный).
INSERT INTO telegram_chats (chat_id, type, title)
VALUES (-1001234567890, 'channel', 'Основной канал')
ON DUPLICATE KEY UPDATE type = VALUES(type), title = VALUES(title);

-- 2. Подписать его на всё, что сейчас включено. Идемпотентно: повторный запуск не создаёт дублей.
INSERT INTO server_subscriptions (server_id, chat_id)
SELECT server.id, -1001234567890
FROM monitored_servers server
WHERE server.enabled = 1
ON DUPLICATE KEY UPDATE server_subscriptions.id = server_subscriptions.id;
```

Имя колонки в `ON DUPLICATE KEY UPDATE` квалифицировано не для красоты: во втором запросе есть
алиас `server`, и голое `id = id` MariaDB отвергает как неоднозначное (`ERROR 1052`).

После правки БД дёрнуть admin endpoint:

```bash
curl -X POST http://localhost:3000/internal/reload-servers        # добавили/удалили/выключили сервер или подписку
curl -X POST http://localhost:3000/internal/force-reload-servers  # изменили поля существующего сервера
```

### Миграции

Файлы — `src/migrations/NNN_описание.sql`, применяются по возрастанию номера. Применённые версии
лежат в `schema_migrations` (`version`, `name`, `checksum`, `applied_at`); таблицу создаёт сам мигратор,
первой миграцией её описать нельзя — некуда было бы записать, что первая миграция применена.

Применяет **отдельный процесс** `src/migrate.ts` (`npm run migrate` в разработке,
`node dist/migrate.js` в образе), а не приложение: см. `PLAN.md`, «Миграции применяются отдельной
командой, не из main». В прод-compose это одноразовый сервис `migrate`, приложение ждёт его успеха
через `service_completed_successfully`.

Правила, заложенные в мигратор:

- **применённую миграцию править нельзя** — сверяется контрольная сумма файла, при расхождении
  команда отказывается работать целиком. Иначе прод и дев расходятся молча: версия одна, схема разная;
- **посторонний файл в каталоге роняет команду** — молча пропущенная миграция хуже отказа;
- **версия записывается только после успешного применения**, поэтому упавшую миграцию повторит
  следующий запуск. DDL в MariaDB не транзакционный, поэтому миграции держим мелкими
  и по возможности идемпотентными (`IF NOT EXISTS`);
- применённая версия, которой нет среди файлов, — предупреждение, а не отказ: схема рабочая,
  неполна лишь её история.

`CREATE DATABASE` и `GRANT` мигратору не принадлежат: это провижининг
(`.docker/mariadb/init/01-databases.sql`), он выполняется от root при первой инициализации тома.
Мигратор подключается к уже существующей базе.

**Тесты используют тот же мигратор.** Своего DDL у них больше нет: `migrateTestDatabase()` читает
тот же каталог миграций и своим подключением (с `multipleStatements`, как в проде) приводит
`tsbot_test` к актуальной схеме. Поэтому схема существует ровно в одном месте, и разъехаться копиям
больше негде. `truncateTestDatabase` чистит две корневые таблицы — `monitored_servers`
и `telegram_chats`; источники и подписки уносит `ON DELETE CASCADE`. `schema_migrations` не чистится:
это состояние схемы, а не данные теста. Обе функции сначала вызывают `assertTestDatabase`, который
отказывается работать с базой, чьё имя не кончается на `_test`.

**Тесты по живой БД идут последовательно** (`--test-concurrency=1` в `test` и `test:repo`).
`node --test` по умолчанию запускает файлы параллельно, каждый в своём процессе, а база у них одна:
`DELETE` из одного файла сносит строки, которые вставил другой. Пока в БД лез единственный файл,
это не проявлялось; со вторым — сразу пять падений в `ServerRepository.test.ts`. `test:unit` флага
не имеет: он к базе не ходит.

## 7. Сборка, запуск, деплой

### Локальная разработка

Окружение целиком описано в `.docker/` — там же и прод. Подробности и команды: `.docker/README.md`.

```bash
cd .docker
docker compose -f compose.dev.yaml up -d     # MariaDB с базами teamspeak, tsbot, tsbot_test
```

Дальше приложение и тесты запускаются **на хосте** — закоммиченные `.env` и `.env.test` указывают
на `localhost:3306`, а пароли в дев-compose специально совпадают с ними, поэтому настраивать нечего.
Остальное под профилями: `--profile teamspeak` (TeamSpeak 6 на 10022, ServerQuery-пароль `devquery`)
и `--profile app` (приложение в контейнере).

Прод и дев изолированы по построению: разные имена проектов (`teamspeak6` против `tsbot-dev`)
и разные имена томов — дев физически не может подключиться к прод-данным.

Базы `tsbot` и `tsbot_test` создаёт `.docker/mariadb/init/01-databases.sql` — это **провижининг**,
а не миграция схемы: мигратор подключается к уже существующей базе и создать её сам не может.
Скрипты выполняются только при первой инициализации тома.

> Дев-сеть объявлена с явной подсетью `172.28.0.0/24`. Причина: при поднятом full-tunnel VPN его
> маршруты накрывают весь диапазон Docker'а, и `docker compose up` падает с
> `all predefined address pools have been fully subnetted`. С явной подсетью аллокатор пула
> не участвует, и окружение поднимается при любом состоянии VPN.


### Команды (из `teamSpeakMonitoring/`)

```bash
npm install
npm run dev        # NODE_ENV=dev tsx watch src/main.ts
npm run build      # tsc -p tsconfig.json → dist/
npm start          # node dist/main.js
npm run migrate    # NODE_ENV=dev; применить недостающие миграции. Прод ходит мимо этого скрипта:
                   # там node dist/migrate.js прямо в образе (compose.prod.yaml, сервис migrate)
npm run typecheck  # tsc по прод-конфигу и по tsconfig.test.json (тесты тоже под проверкой)
npm run test:unit  # логика без БД; сначала автоматически гоняет typecheck
npm test           # всё, включая интеграционный тест по живой MariaDB
npm run test:repo  # только src/persistence/*.test.ts
```

### Prod

- `teamSpeakMonitoring/Dockerfile` — multi-stage: build (`npm ci` + `tsc`) → runtime (`npm ci --omit=dev`
  + `dist/`), `USER node`, `NODE_ENV=production`, `CMD node dist/main.js`.
- Сборка образа — GitHub Actions `docker-build.yml`, запуск **только вручную** (`workflow_dispatch`,
  input `service=monitor`). Публикует `ghcr.io/<repo>/tsbot-monitor:latest` и `:sha-<sha>`.
- Prod-compose лежит в репозитории: `.docker/compose.prod.yaml` — TeamSpeak 6, MariaDB и
  `tsbot-monitor` из GHCR. Имя проекта, имена контейнеров, томов и порты сохранены один в один
  с тем вариантом, который уже работает на сервере, иначе docker создал бы новые тома и прод потерял
  бы данные. Чувствительных данных в репозитории нет: нужны `env/secrets.env` (пароли для подстановки)
  и `env/tsbot.env` (конфигурация приложения, монтируется как `/app/.env.local`) — оба гитигнорятся,
  шаблоны рядом. Запуск: `docker compose --env-file env/secrets.env -f compose.prod.yaml up -d`.
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
5. ✅ **Закрыто, итерация 10.** Каждый querier первой строкой сужает конфиг через
   `narrowQueryConfig(config, "<type>")` и бросает понятную ошибку на чужом типе; каст исчез.
   Форма конфига по-прежнему проверяется в `parseQueryConfig` только там, где поломка иначе
   не проявилась бы (карта у `rest`, `hostAddress` у `bohemia`). Исходная запись:
   `queriers/*` делали непроверенный
   `config as A2sQueryConfig` / `as RestQueryConfig`. Дефект начинается раньше — в `parseQueryConfig`:
   там сверяется только `type`, а форма конфига не проверяется, поэтому `{"type":"a2s"}` без `host`
   и `port` спокойно доезжает до querier'а и падает уже в опросе. Теперь это поведение закреплено
   тестом («поля внутри конфига не проверяются»), так что починка сразу покажет, что изменилось.
   Каст в querier'ах работает только потому, что `ServerMonitor` выбирает querier по `type`.
   Стоит дискриминировать явно.
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
11. 🔽 **Понижен в приоритете 2026-07-31 (решение zalex).** `AdminServer` поддерживает bearer-токен,
   но `main.ts` передаёт только `port`, поэтому эндпоинты открыты без авторизации на `0.0.0.0:3000`.
   Обоснование отсрочки: в prod порт опубликован только на localhost, а сами эндпоинты безобидны —
   они лишь перечитывают список серверов из БД, ничего не удаляют и данных не выдают. **Планируется
   вообще убрать эту поверхность:** управление серверами переедет в Telegram-бота, и тогда
   HTTP-эндпоинты либо исчезнут, либо станут внутренними. Токен раньше этого делать незачем.
12. 🟡 **Частично, итерация 5b.** `emitChangedIfNeeded()` вызывается после каждого poll каждого probe:
    при N серверах вид пересчитывается и сериализуется N раз за цикл. Сравнение — через
    `JSON.stringify`. Сама лишняя работа осталась; закрыто её **последствие** — обновления TeamSpeak
    больше не копятся очередью, за это отвечает `LatestOnlyNotifier`.
13. ✅ **Закрыто, итерация 5a.** `ServerProbe` эмитил `playersChanged` и `serverStatusChanged`
    без единого подписчика. Оба удалены вместе с типом `ServerStatusEvent` — тем самым, о котором
    в коде стоял комментарий «зачем собирать сообщение чтоб потом из него забирать одно поле».
    У probe осталось ровно два события — переходы статуса. Изменение числа игроков наружу отдаёт
    `ServerMonitor` через `stateUpdated`.
14. `forceSync` пересоздаёт probes, теряя `status`/`statusSince`/`failedChecks` — после него все серверы
    заново проходят `unknown → online`.

    **Симптом в Telegram, похоже, исчез сам после 8b — но тестом это не закреплено.** Память
    `ChangesOnlyNotifier` живёт в нотифаере, а не в probe, поэтому `forceSync` её не сбрасывает:
    повторный переход `unknown → online` даст событие, но обёртка увидит, что `serverOnline`
    по этому серверу уже доставлен, и промолчит. Повторные «is online» остаются только при
    **рестарте процесса**. Сама потеря `statusSince` не лечится: `/time` после `forceSync`
    покажет время с момента пересоздания probe, а не с момента реальной смены статуса.
    Проверить это тестом — отдельный маленький шаг.
15. `ServerProbe` конструктор: обязательный `logger` идёт после параметров с дефолтами.
16. `ChannelDescriptionRenderer` форматирует время жёстко в `Europe/Moscow` и вызывает `new Date()` внутри — это
    делает вид недетерминированным и нетестируемым.
25. **`main.ts` читается плохо: шесть разных тем в одной функции** (разобрано 2026-08-07, брать
    после функционала Telegram). 357 строк, из них `main()` — 266. По объёму: сборка подписок
    на уведомления ~90 строк, пересинк списка опроса ~55, создание объектов ~25, shutdown ~25,
    проброс событий монитора ~20, Telegram ~25, запуск ~17. Плюс порядок чтения обратен порядку
    исполнения: `syncMonitorServersFromRepository` используется на строках 122 и 262, а объявлена
    на 297 — работает только благодаря хостингу функций.
    Кандидаты, по возрастанию спорности:
    - **вынести пересинк списка опроса** (`logBuildNotice`, `loadMonitorConfigs`,
      `loadBoardServerIds`, обе `sync*`) в объект с именем — это одна связная тема, сейчас
      безымянная и размазанная. Минус ~55 строк, риска нет;
    - **вынести graceful shutdown** — порядок остановки должен читаться списком, а не выковыриваться
      из тела замыкания. Минус ~25 строк;
    - **вынести сборку подписок** в чистую `buildSubscriptions(deps, config)`. Минус ~90 строк,
      и её впервые можно проверить тестом («при `teamspeak=false` подписок teamspeak нет»).
      **Спорно:** §10 прямо обещает, что «какой канал каким правилом обёрнут — видно в `main.ts`».
      Это правка принципа, а не рефакторинг, и требует отдельного решения;
    - **бесплатно:** часть комментариев в `main.ts` дублирует семантику, уже описанную в самих
      обёртках. В composition root достаточно «почему здесь такой ключ», остальное — в классе.
    Чего делать НЕ надо: DI-контейнера (отклонён в `PLAN.md`), класса `Application` со всем внутри
    (та же простыня, вид сбоку), механической резки по файлам ради длины.

**Инструментарий**

17. 🟡 **Частично, итерация 6b.** Мигратор есть (см. §6); линтера и форматтера по-прежнему нет.
24. ✅ **Закрыто, итерации 8a и 8b. Потеря доставки не восстанавливалась.** Один корень: обновление
    уходило только в момент **изменения** состояния, повторять упавшую доставку было некому.

    **TeamSpeak — закрыто (8a).** `StateSync` раз в `MONITOR_STATE_SYNC_INTERVAL_MS` публикует текущее
    состояние событием `serverStateRepublished`, и описание канала перезаписывается безусловно. Воспроизводимый
    сценарий (все серверы ушли в offline → TeamSpeak в этот момент недоступен → доставка упала →
    накопленное состояние выброшено → состояние больше не меняется → в описании навсегда «online 12/64»)
    теперь заканчивается записью на следующем тике; зафиксировано тестом `StateSync.test.ts`.
    Заодно откатывается правка описания, сделанная в TeamSpeak руками, и лечится возврат TeamSpeak
    после долгой недоступности. Предупреждение `Pending notification dropped after delivery failure`
    в `LatestOnlyNotifier` остаётся — потеря по-прежнему реальна, просто теперь у неё есть починка.
    Повтор с backoff внутри обёртки рассматривался и отклонён: он закрывает только короткий сбой,
    а главный сценарий (состояние больше не меняется) — нет.

    **Telegram — закрыто (8b).** `serverOnline` эмитится только на переходе статуса, поэтому упавшая
    отправка «сервер онлайн» терялась до следующего падения и подъёма того же сервера. Безусловная
    периодическая отправка здесь недопустима (журнал, а не табло — вышло бы 1440 сообщений в сутки),
    поэтому тик публикует статусы серверов, а `ChangesOnlyNotifier` сравнивает их с последней
    **успешной** доставкой по этому серверу: упавшая не запомнилась и повторится следующим тиком,
    совпадающая молчит. Серверы в `unknown` не публикуются вовсе.

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
22. ✅ **Закрыто, итерация 9.** Тесты были исключены из `tsc` (`exclude` в `tsconfig.json`), поэтому
    **не проходили проверку типов**, и правка контракта ломала тест молча — обнаруживалось только
    на прогоне. Так вышло дважды: в итерации 4a (`new RestQuerier()` остался без обязательного
    `Logger`) и в 8b (в фикстуре не появился `getSnapshot` из `CurrentStateSource` — пять упавших
    тестов). Добавлен `tsconfig.test.json` (наследует основной, ничего не исключает, только проверка
    без эмита) и `npm run typecheck`, повешенный на `pretest:unit`. Сборка по-прежнему идёт через
    `tsconfig.json`, поэтому в `dist` тестов нет. Отдельного внимания стоит следствие: гарантии
    уровня типов теперь можно закреплять тестом — до этого `@ts-expect-error` в тесте не проверялся
    ничем (в 5a пришлось удалить такой тест как театральный).
18. ✅ **Закрыто, итерация 1.** `src/test/databaseTestUtils.ts` импортировал `ServerQueryConfig`
    без `type` и без расширения `.js` — под NodeNext/`verbatimModuleSyntax` невалидно, но не ловилось,
    т.к. тесты исключены из `tsc`. Там же закрыто: `npm test` находил 0 тестов и рапортовал успех
    (Node 20 не подхватывает `.ts` по дефолтным шаблонам) — добавлен явный glob и скрипт `test:unit`.
19. ✅ **Закрыто, итерация 6c.** `.env.test` указывал на ту же БД `tsbot`, что и локальная разработка,
    а тесты делают `TRUNCATE`. Теперь `DB_NAME=tsbot_test`, схему в ней приводит тот же мигратор,
    что в проде, а `assertTestDatabase` отказывается работать с базой, имя которой не кончается
    на `_test` — попадание не в ту базу перестало быть возможным по невнимательности.

## 9. Планы

- **Saiga / LLM (скоро).** `src/Saiga.ts` — уже написанный клиент к OpenAI-совместимому endpoint
  (Ollama, локальный GPU-хост, напр. `http://192.168.3.57:11434`), модель `ilyagusev/saiga_nemo_12b`.
  Замысел: генерировать короткие абсурдные русские тексты по событиям и постить в Telegram-канал,
  а дальше — озвучивать их и проигрывать в TeamSpeak через **SinusBot** (он сидит в канале TS6;
  API-запросы к нему — в `sinusbot.http`). Работы приостановлены, пока не работает GPU-сервер,
  но будут продолжены — это не мёртвый код.
- **Автоматизация заполнения `.env.local`** (Makefile или генератор из схемы convict), чтобы
  не вспоминать обязательные переменные вручную. Сам prod-compose в репозитории уже есть
  (`.docker/compose.prod.yaml`), шаблоны — в `.docker/env/`.
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
- **Политика доставки — обёртка, а не логика внутри нотифаера.** `LatestOnlyNotifier` (промежуточные
  выбрасываем) и `ChangesOnlyNotifier` (молчим, если то же уже доставлено) — это правила **доставки**,
  а не работа канала: канал умеет только «записать описание» / «отправить текст». Обёртки называются
  по своему правилу, реализуют тот же `Notifier<TType>` и потому прозрачны для диспетчера, а какой
  канал каким правилом обёрнут — видно в `main.ts`. Именно поэтому одно и то же решение может быть
  для одного канала верным, а для другого запрещённым: TeamSpeak — табло, Telegram — журнал.
- **Ключи `ChangesOnlyNotifier`: в `stateOf` попадает всё, от чего зависит текст.** Сейчас передано
  `event => event.type`, и это верно, потому что текст в `TelegramStatusNotifier` — ровно
  `${name} is online`, то есть двух разных «online»-сообщений по одному серверу не существует.
  Как только в сообщение попадут данные (число игроков, карта, текст от модели), такой ключ начнёт
  **глушить настоящие обновления**: состояние «то же», а сказать есть что. Тогда `stateOf` должен
  включать эти данные (`${event.type}:${players}`). Правится одной лямбдой в `main.ts` — там же,
  где видно, из чего собирается текст. В `subjectOf`, наоборот, состояние попадать **не должно**:
  иначе `Map` вырождается в `Set` и повторный подъём сервера после падения теряется.
- **Две конфигурации TypeScript.** `tsconfig.json` — сборка (`npm run build`), исключает тесты, чтобы
  они не попадали в `dist`. `tsconfig.test.json` — только проверка типов, наследует основной и
  **ничего не исключает**. Обе гоняет `npm run typecheck`, и он же висит на `pretest:unit`, поэтому
  прогон тестов начинается с проверки типов и на ошибке до тестов не доходит. Правя контракт,
  которым пользуются тесты, ошибку видно в компиляции, а не в виде рантайм-каскада.
- Event-driven связка через `node:events`; обработчики, передаваемые в `on`/`off`, объявляются как
  `private readonly handler = (…) => {}` (иначе `off` не снимет подписку).
- Комментарии в коде — на русском, короткие, объясняют «почему», а не «что». `FIXME`/`TODO` в коде
  оставлены осознанно.
- Ошибки в фоновых операциях гасятся на границе (`Promise.allSettled` в `NotificationDispatcher`, `try/catch` в
  queriers) — падение одного канала доставки не должно ронять процесс.
- Graceful shutdown в `main.ts` на `SIGTERM`/`SIGINT`: monitor → notifier → telegram → teamspeak →
  admin server → db pool.
