import type {Notifier, NotificationEventOf} from "./events.js";
import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";
import type {Logger} from "pino";

//Своя проекция снапшотов, отдельная от той, что рисует описание канала TeamSpeak.
//Общей делать нечего: журналу нужны id и статусы, табло — имена и счёт, а снапшот целиком тащит
//в лог конфиг с адресами и таймаутами каждого источника.
//Экспортируется, потому что этой же выжимкой дедуплицируется доставка: журнал должен писать
//строку при изменении данных, а событие теперь приходит после каждого опроса.
//
//failedChecks — ради тихих неудач: пока порог offline не набран, статус и игроки не меняются,
//и без этого поля короткий простой не оставлял в логе ни следа. После игры 1.9 перезапуск
//сервера уложился именно в такое окно (telegram.md, §11) — по этим строкам его длина и видна.
export function summarizeForLog(snapshots: readonly ServerProbeSnapshot[]): unknown[] {
    return snapshots.map(server => ({
        id: server.config.id,
        name: server.config.name,
        status: server.status,
        failedChecks: server.failedChecks,
        players: server.currentInfo?.players,
        maxPlayers: server.currentInfo?.maxPlayers,
        queueSize: server.currentInfo?.queueSize,
    }));
}

export class LogNotifier implements Notifier<"serverStateUpdated"> {
    constructor(private readonly logger: Logger) {
    }

    public async notify(event: NotificationEventOf<"serverStateUpdated">): Promise<void> {
        this.logger.info({servers: summarizeForLog(event.snapshots)}, "Состояние серверов изменилось");
    }
}
