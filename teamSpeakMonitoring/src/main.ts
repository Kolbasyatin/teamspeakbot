import "dotenv-flow/config";
import {ServerMonitor} from "./monitoring/ServerMonitor.js";
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
    tsNotifierChannelNames,
} from "./properties.js";
import {notifierConfig} from "./notifierConfig.js";
import {NotificationDispatcher} from "./notifications/NotificationDispatcher.js";
import type {NotificationSubscription} from "./notifications/events.js";
import {TSNotifier} from "./notifications/TSNotifier.js";
import {LogNotifier} from "./notifications/LogNotifier.js";
import {TelegramBot} from "./telegram/TelegramBot.js";
import {TelegramSender} from "./telegram/TelegramSender.js";
import {TelegramOnlineHandler} from "./notifications/TelegramOnlineHandler.js";
import {TelegramOfflineHandler} from "./notifications/TelegramOfflineHandler.js";
import {TeamSpeakConnection} from "./teamspeak/TeamSpeakConnection.js";
import {TeamSpeakClient} from "./teamspeak/TeamSpeakClient.js";
import {Bot} from "grammy";
import {retry} from "./retry.js";

//БД может подняться позже нас (в compose она стартует рядом), поэтому первое чтение серверов
//не должно ронять процесс. Суммарно даёт около 90 секунд на готовность MariaDB.
const startupDbRetry = {
    attempts: 10,
    initialDelayMs: 1_000,
    maxDelayMs: 15_000,
} as const;

async function main(): Promise<any> {
    const monitor: ServerMonitor = new ServerMonitor(monitorProperties, log);
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
    //вовсе, поэтому хендлерам не нужен ни флаг активности, ни знание о конфигурации.
    const subscriptions: NotificationSubscription[] = [];

    if (notifierConfig.log) {
        subscriptions.push({
            event: "statusViewChanged",
            name: "log",
            handler: new LogNotifier(log),
        });
    }

    if (notifierConfig.teamspeak) {
        subscriptions.push({
            event: "statusViewChanged",
            name: "teamspeak",
            handler: new TSNotifier(teamSpeakClient, tsNotifierChannelNames.channels),
        });
    }

    if (notifierConfig.telegram && telegramApi) {
        const telegramSender = new TelegramSender(telegramApi, tgProperties.channelId);

        subscriptions.push({
            event: "serverOnline",
            name: "telegram:online",
            handler: new TelegramOnlineHandler(telegramSender),
        });
        subscriptions.push({
            event: "serverOffline",
            name: "telegram:offline",
            handler: new TelegramOfflineHandler(telegramSender),
        });
    }

    if (notifierConfig.telegram && !telegramApi) {
        log.warn("TELEGRAM_NOTIFIER включен, но TELEGRAM_TOKEN пуст — уведомления в Telegram отключены");
    }

    const dispatcher = new NotificationDispatcher(subscriptions, log);

    monitor.on("viewChanged", view => {
        void dispatcher.notify({
            type: "statusViewChanged",
            view,
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

    async function syncMonitorServersFromRepository(): Promise<void> {
        const servers = await serverRepository.findAllEnabled();
        monitor.syncServers(servers);

    }

    async function forceSyncMonitorServersFromRepository(): Promise<void> {
        const servers = await serverRepository.findAllEnabled();
        monitor.forceSync(servers);
    }

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        console.log(signal)
        monitor.stop();
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
    telegramBot?.start();
}

try {
    await main();
} catch (error) {
    log.fatal({error}, "Не удалось запустить приложение");
    process.exit(1);
}
