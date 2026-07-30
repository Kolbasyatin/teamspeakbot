import "dotenv-flow/config";
import {ServerMonitor} from "./a2s/ServerMonitor.js";
import {log} from "./logger.js";
import {AdminServer} from "./server/AdminServer.js";
import {ServerRepository} from "./repositories/ServerRepository.js";
import {createPool} from "mariadb";
import {dbConfig, properties, syncConfig, tgProperties, monitorProperties} from "./properties.js";
import {Notifier} from "./Notifiers/Notifiers.js";
import {TelegramBot} from "./tg/TelegramBot.js";
import {TeamSpeakConnection} from "./teamspeak/TeamSpeakConnection.js";
import {TeamSpeakClient} from "./teamspeak/TeamSpeakClient.js";
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
    const notifier = new Notifier(teamSpeakClient);
    const pool = createPool(dbConfig);
    const serverRepository = new ServerRepository(pool);
    const adminWebServer = new AdminServer({
        port: syncConfig.port
    })
    const telegramBot = new TelegramBot(tgProperties.token, monitor, teamSpeakClient);

    monitor.on("viewChanged", view => {
        void notifier.notify({
            type: "statusViewChanged",
            view,
        });
    });

    monitor.on("serverOnline", snapshot => {
        void notifier.notify({
            type: "serverOnline",
            snapshot,
        });
    });

    monitor.on("serverOffline", snapshot => {
        void notifier.notify({
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
        void await notifier.close();
        void await telegramBot.stop();
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
    void telegramBot.start();
}

try {
    await main();
} catch (error) {
    log.fatal({error}, "Не удалось запустить приложение");
    process.exit(1);
}
