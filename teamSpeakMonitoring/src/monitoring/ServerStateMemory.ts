import type {RestoredProbeState, ServerProbeSnapshot} from "./ServerProbe.js";

//Память статусов серверов между рестартами процесса (итерация 22). Здесь только правила —
//что сохранять и что из сохранённого можно восстановить; хранит ServerStateRepository.

export interface SavedServerState {
    serverId: number;
    status: "online" | "offline";
    //С какого момента держится статус — то, что /status показывает как «онлайн уже N».
    since: Date;
    //Когда статус последний раз подтверждён живым процессом. По нему видно, насколько
    //сохранённое устарело, а заодно — сколько бот не работал.
    confirmedAt: Date;
}

export interface ServerStateStore {
    loadStates(): Promise<SavedServerState[]>;

    saveStates(states: readonly SavedServerState[]): Promise<void>;
}

//unknown не сохраняется: о нём сказать нечего, после рестарта с него и так начинают.
export function savedStatesOf(snapshots: readonly ServerProbeSnapshot[], now: Date): SavedServerState[] {
    return snapshots.flatMap(snapshot => snapshot.status === "unknown" ? [] : [{
        serverId: snapshot.config.id,
        status: snapshot.status,
        since: snapshot.statusSince,
        confirmedAt: now,
    }]);
}

//Восстанавливается только свежее. Обновление бота занимает секунды; сохранённое час назад уже
//ничего не говорит о сейчас: сервер мог упасть и подняться, пока бота не было, и «онлайн уже
//3 дня» стало бы ложью. Тогда probe начинает с unknown, как раньше, — а лишних сообщений всё равно
//не будет: их сдерживает память доставок (StatusDeliveryJournal), она от возраста не зависит.
export function restorableStates(
    saved: readonly SavedServerState[],
    now: Date,
    maxAgeMs: number,
): Map<number, RestoredProbeState> {
    const restorable = new Map<number, RestoredProbeState>();

    for (const state of saved) {
        if (now.getTime() - state.confirmedAt.getTime() <= maxAgeMs) {
            restorable.set(state.serverId, {status: state.status, since: state.since});
        }
    }

    return restorable;
}

//Последнее подтверждение — оценка того, когда процесс перестал работать.
export function lastConfirmedAt(saved: readonly SavedServerState[]): Date | undefined {
    return saved.reduce<Date | undefined>(
        (latest, state) => latest === undefined || state.confirmedAt > latest ? state.confirmedAt : latest,
        undefined,
    );
}
