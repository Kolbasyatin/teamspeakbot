import type {Notifier, NotificationEventOf} from "./events.js";
import {savedStatesOf, type ServerStateStore} from "../monitoring/ServerStateMemory.js";

type StoredEventType = "serverStateRepublished" | "serverOnline" | "serverOffline";

//Канал доставки «хранилище»: статусы серверов в базу, чтобы рестарт не начинал их с unknown
//(итерация 22). Два источника, и нужны оба:
//  переход статуса — сразу, чтобы «с какого момента» было точным;
//  периодическая публикация (раз в MONITOR_STATE_SYNC_INTERVAL_MS) — подтверждает, что статус
//    всё ещё такой: по отметке подтверждения при старте решается, свежее ли сохранённое.
//Отказ записи уходит в NotificationDispatcher и в лог; следующий тик повторит.
export class StateStoreNotifier implements Notifier<StoredEventType> {
    constructor(
        private readonly store: ServerStateStore,
        private readonly now: () => Date = () => new Date(),
    ) {
    }

    public async notify(event: NotificationEventOf<StoredEventType>): Promise<void> {
        const snapshots = event.type === "serverStateRepublished" ? event.snapshots : [event.snapshot];
        const states = savedStatesOf(snapshots, this.now());

        if (states.length > 0) {
            await this.store.saveStates(states);
        }
    }
}
