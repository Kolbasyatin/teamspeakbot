import "dotenv-flow/config";
import {ServerMonitor} from "./monitoring/ServerMonitor.js";
import {A2sQuerier} from "./queriers/A2sQuerier.js";
import {RestQuerier} from "./queriers/RestQuerier.js";
import {log} from "./logger.js";
import {AdminServer} from "./admin/AdminServer.js";
import {ServerRepository} from "./persistence/ServerRepository.js";
import {createPool} from "mariadb";
import {
    dbConfig,
    properties,
    syncConfig,
    tgProperties,
    monitorProperties,
    stateSyncProperties,
    teamSpeakChannelNames,
} from "./properties.js";
import {notifierConfig} from "./notifierConfig.js";
import {NotificationDispatcher} from "./notifications/NotificationDispatcher.js";
import {subscribe, type NotificationSubscription} from "./notifications/events.js";
import {TeamSpeakChannelNotifier} from "./notifications/TeamSpeakChannelNotifier.js";
import {LatestOnlyNotifier} from "./notifications/LatestOnlyNotifier.js";
import {StateSync} from "./notifications/StateSync.js";
import {ChangesOnlyNotifier} from "./notifications/ChangesOnlyNotifier.js";
import {type ScheduledTask, Scheduler} from "./monitoring/Scheduler.js";
import {LogNotifier, summarizeForLog} from "./notifications/LogNotifier.js";
import {ChannelDescriptionRenderer} from "./teamspeak/ChannelDescriptionRenderer.js";
import {TelegramBot} from "./telegram/TelegramBot.js";
import {TelegramSender} from "./telegram/TelegramSender.js";
import {TelegramStatusNotifier} from "./notifications/TelegramStatusNotifier.js";
import {TeamSpeakConnection} from "./teamspeak/TeamSpeakConnection.js";
import {TeamSpeakClient} from "./teamspeak/TeamSpeakClient.js";
import {Bot} from "grammy";
import {retry} from "./retry.js";
import {buildMonitorConfigs, type BuildNotice} from "./monitoring/buildMonitorConfigs.js";
import type {ServerMonitorConfig} from "./monitoring/MonitoredServer.js";

//Предупреждения сборки конфигов — единственное место, где они превращаются в текст.
//switch, а не if: новый вариант BuildNotice обязан получить свою ветку, иначе присваивание
//в never не скомпилируется и предупреждение потерялось бы молча.
function logBuildNotice(notice: BuildNotice): void {
    switch (notice.type) {
        case "noEnabledSources":
            log.warn(
                {serverId: notice.serverId, name: notice.serverName},
                "У сервера нет включённых источников опроса — он пропущен",
            );
            return;
        case "primaryFallback":
            log.warn(
                {serverId: notice.serverId, name: notice.serverName, sourceId: notice.sourceId},
                "Нет включённого primary-источника — статус определяет самый приоритетный из оставшихся",
            );
            return;
        default: {
            const unhandled: never = notice;
            log.warn({notice: unhandled}, "Неизвестное предупреждение сборки конфигов");
        }
    }
}

//БД может подняться позже нас (в compose она стартует рядом), поэтому первое чтение серверов
//не должно ронять процесс. Суммарно даёт около 90 секунд на готовность MariaDB.
const startupDbRetry = {
    attempts: 10,
    initialDelayMs: 1_000,
    maxDelayMs: 15_000,
} as const;

async function main(): Promise<any> {
    //Реализации опроса живут здесь: монитор про протоколы не знает. Добавление типа запроса
    //в ServerQueryConfig валит сборку, пока сюда не добавят его querier.
    const monitor: ServerMonitor = new ServerMonitor(monitorProperties, log, {
        a2s: new A2sQuerier(log),
        rest: new RestQuerier(log),
    });
    //Одно query-подключение к TeamSpeak на процесс: его делят нотифаер и команды бота.
    const teamSpeakConnection = new TeamSpeakConnection(properties, log);
    const teamSpeakClient = new TeamSpeakClient(teamSpeakConnection);
    const pool = createPool(dbConfig);
    const serverRepository = new ServerRepository(pool);
    const adminWebServer = new AdminServer({
        port: syncConfig.port
    })

    //Telegram доступен только при непустом токене: grammy бросает "Empty token!" в конструкторе.
    //Один Bot на процесс — его делят команды бота и отправка уведомлений.
    const telegramApi = tgProperties.token ? new Bot(tgProperties.token) : undefined;
    //Команды (/time, /who, /id) не зависят от TELEGRAM_NOTIFIER: тот флаг управляет только
    //уведомлениями о статусах серверов.
    const telegramBot = telegramApi
        ? new TelegramBot(telegramApi, monitor, teamSpeakClient)
        : undefined;

    if (!telegramApi) {
        log.info("TELEGRAM_TOKEN пуст — Telegram отключён целиком: ни команд, ни уведомлений");
    }

    //Единственное место, где решается, что куда отправляется. Выключенный канал не создаётся
    //вовсе, поэтому нотифаерам не нужен ни флаг активности, ни знание о конфигурации.
    const subscriptions: NotificationSubscription[] = [];

    if (notifierConfig.log) {
        //Своя дедупликация, не общая с TeamSpeak: журналу интересно изменение ДАННЫХ, поэтому
        //сравнивается его собственная выжимка. Событие приходит после каждого опроса, без обёртки
        //в лог уходила бы строка каждые несколько секунд.
        subscriptions.push(subscribe("serverStateUpdated", "log", new ChangesOnlyNotifier(
            new LogNotifier(log),
            () => "servers",
            event => JSON.stringify(summarizeForLog(event.snapshots)),
        )));
    }

    if (notifierConfig.teamspeak) {
        //Описание канала — табло текущего состояния, а не журнал: пока идёт запись, промежуточные
        //обновления не нужны. Без обёртки они копятся очередью на единственном SSH-соединении.
        //Telegram оборачивать нельзя — там каждое событие самостоятельный факт.
        //Один экземпляр на оба события: обёртка должна склеивать их вместе, иначе периодическая
        //синхронизация и реальное изменение получат по своей очереди доставки.
        const channelBoard = new LatestOnlyNotifier(
            new TeamSpeakChannelNotifier(teamSpeakClient, teamSpeakChannelNames.channels),
            log,
        );

        //Ячейка одна на всё табло: описание пишется во все каналы одинаковым текстом, различать
        //нечего. Ключ — ТЕКСТ описания без отметки времени: вопрос «лезть ли в TeamSpeak»
        //эквивалентен вопросу «изменится ли то, что увидит человек». Отсюда renderBody, а не
        //render: время в ключе меняется каждую секунду и убило бы дедупликацию совсем.
        subscriptions.push(subscribe("serverStateUpdated", "teamspeak", new ChangesOnlyNotifier(
            channelBoard,
            () => "channelDescription",
            event => ChannelDescriptionRenderer.renderBody(event.snapshots),
        )));
        //А это — мимо дедупликации, безусловной записью: так откатывается правка описания,
        //сделанная в TeamSpeak руками. О ней мы узнать не можем, поэтому и молчать не имеем права.
        subscriptions.push(subscribe("serverStateRepublished", "teamspeak", channelBoard));
    }

    if (notifierConfig.telegram && telegramApi) {
        const telegramSender = new TelegramSender(telegramApi, tgProperties.channelId);
        //Один нотифаер на оба события: текст берётся из таблицы внутри него.
        //Канал Telegram — журнал, а не табло, поэтому обёртка обратная TeamSpeak'у: отправляем
        //только при расхождении с последним успешно доставленным статусом этого сервера.
        //Без неё периодическая синхронизация дала бы 1440 сообщений «is online» в сутки;
        //с ней упавшая отправка повторяется следующим тиком, а совпадающая молчит.
        //
        //Ячейка на каждый сервер, ключ — тип события. Один экземпляр обёртки на ОБА события:
        //подпишешь два разных — у каждой будет своя память, и повтор «is online» после offline
        //не уйдёт никогда. Тип в subject класть по той же причине нельзя.
        const telegramStatusNotifier = new ChangesOnlyNotifier(
            new TelegramStatusNotifier(telegramSender),
            event => String(event.snapshot.config.id),
            event => event.type,
        );

        subscriptions.push(subscribe("serverOnline", "telegram", telegramStatusNotifier));
        subscriptions.push(subscribe("serverOffline", "telegram", telegramStatusNotifier));
    }

    if (notifierConfig.telegram && !telegramApi) {
        log.warn("TELEGRAM_NOTIFIER включен, но TELEGRAM_TOKEN пуст — уведомления в Telegram отключены");
    }

    const dispatcher = new NotificationDispatcher(subscriptions, log);

    //Периодическая публикация текущего состояния. Часы держит Scheduler, а не монитор и не нотифаер:
    //у него уже есть пер-задачные таймеры, изоляция исключений и start/stop, а монитор остаётся
    //без зависимости от времени и детерминированным для тестов.
    const stateSync = new StateSync(monitor, dispatcher);
    const stateSyncScheduler = new Scheduler<ScheduledTask>(log);
    stateSyncScheduler.sync([{
        id: "stateSync",
        run: (): Promise<void> => stateSync.publishCurrentState(),
        getNextDelayMs: (): number => stateSyncProperties.intervalMs,
    }]);

    monitor.on("stateUpdated", snapshots => {
        void dispatcher.notify({
            type: "serverStateUpdated",
            snapshots,
        });
    });

    monitor.on("serverOnline", snapshot => {
        void dispatcher.notify({
            type: "serverOnline",
            snapshot,
        });
    });

    monitor.on("serverOffline", snapshot => {
        void dispatcher.notify({
            type: "serverOffline",
            snapshot,
        });
    });

    // Admin endpoints обновляют runtime-список серверов в мониторе.
    adminWebServer.on("syncMonitorServers", () => {
        void syncMonitorServersFromRepository().catch(error => {
            log.error({error}, "Failed to sync monitor servers");
        });
    });

    adminWebServer.on("forceSyncMonitorServers", () => {
        void forceSyncMonitorServersFromRepository().catch(error => {
            log.error({error}, "Failed to force sync monitor servers");
        });
    });

    //Прочитать строки и собрать из них доменные конфиги — два разных шага, и сшиты они здесь.
    //Репозиторий отдаёт только то, что лежит в хранилище; правила «кто главный» и «кого
    //опрашивать нечем» применяет buildMonitorConfigs, а логирует их результат composition root:
    //сама сборка чистая и про логи не знает.
    async function loadMonitorConfigs(): Promise<ServerMonitorConfig[]> {
        const {configs, notices} = buildMonitorConfigs(await serverRepository.findMonitored());

        notices.forEach(logBuildNotice);

        return configs;
    }

    async function syncMonitorServersFromRepository(): Promise<void> {
        monitor.syncServers(await loadMonitorConfigs());
    }

    async function forceSyncMonitorServersFromRepository(): Promise<void> {
        monitor.forceSync(await loadMonitorConfigs());
    }

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        console.log(signal)
        monitor.stop();
        stateSyncScheduler.stop();
        if (telegramBot) {
            await telegramBot.stop();
        }
        void await teamSpeakConnection.close();
        void await adminWebServer.stop();
        void await pool.end();
        process.exit(0);
    };

    process.once("SIGTERM", signal => {
        void shutdown(signal).catch(error => {
            log.error({error}, "Shutdown failed");
            process.exit(1);
        })
    });
    process.once("SIGINT", signal => {
        void shutdown(signal).catch(error => {
            log.error({error}, "Shutdown failed");
            process.exit(1);
        })
    });

    void await retry(syncMonitorServersFromRepository, {
        ...startupDbRetry,
        onRetry: (error, attempt, nextDelayMs) => {
            log.warn(
                {error, attempt, nextDelayMs},
                "Не удалось прочитать серверы из БД, повторяю",
            );
        },
    });
    void await adminWebServer.start();
    void monitor.start();
    //Первый тик уходит сразу (Scheduler планирует задачи с нулевой задержкой): описание канала
    //приводится в соответствие с реальностью не дожидаясь первого изменения состояния. Цена —
    //сразу после рестарта в описании на один интервал опроса появятся статусы unknown.
    stateSyncScheduler.start();
    telegramBot?.start();
}

try {
    await main();
} catch (error) {
    log.fatal({error}, "Не удалось запустить приложение");
    process.exit(1);
}
