import type {ServerMonitorConfig, ServerQuerySource, StoredServer} from "./MonitoredServer.js";
import {resolvePrimarySource} from "./resolvePrimarySource.js";

//Превращение прочитанных серверов в готовые к опросу конфиги: упорядочить источники,
//выбрать главного, отсеять тех, кого опрашивать нечем.
//
//Живёт в домене, а не в репозитории, намеренно. Граница такая: хранилище ОТБИРАЕТ (WHERE, JOIN) —
//это язык запроса, и он у каждой БД свой. Хранилище не ВЫВОДИТ: не считает производные поля,
//не выбрасывает сущности по доменному правилу и не решает, о чём предупреждать. Иначе замена
//MariaDB на SQLite означала бы не «переписать чтение», а «переписать чтение и не забыть повторить
//три правила, о которых компилятор не напомнит».
//
//Побочный эффект, ради которого это стоило вынести уже сейчас: правила проверяются юнит-тестами,
//без живой БД. Тот же мотив, по которому из репозитория вынимали parseQueryConfig.

//О чём сборка сообщает наружу. Не исключения: обе ситуации рабочие, ронять из-за них чтение
//остальных серверов нельзя. Но и молчать нельзя, поэтому это данные, а не void.
//Логирует вызывающий — функция про логи не знает и остаётся чистой.
export type BuildNotice =
    | {type: "noEnabledSources"; serverId: number; serverName: string}
    | {type: "primaryFallback"; serverId: number; serverName: string; sourceId: number};

export interface MonitorConfigsBuild {
    configs: ServerMonitorConfig[];
    notices: BuildNotice[];
}

export function buildMonitorConfigs(stored: readonly StoredServer[]): MonitorConfigsBuild {
    const configs: ServerMonitorConfig[] = [];
    const notices: BuildNotice[] = [];

    for (const server of stored) {
        const sources = sortByPriority(server.sources);
        const primarySource = resolvePrimarySource(sources, server.id);

        //Опрашивать нечем. Отдать такой сервер монитору нельзя: probe копил бы неудачи
        //и уехал в offline, хотя никто ни разу не спросил.
        if (!primarySource) {
            notices.push({
                type: "noEnabledSources",
                serverId: server.id,
                serverName: server.name,
            });
            continue;
        }

        //Главным стал помощник: значит назначенный primary отключён или его не было вовсе.
        //Ситуация рабочая, но она меняет то, чем определяется статус сервера.
        if (primarySource.role !== "primary") {
            notices.push({
                type: "primaryFallback",
                serverId: server.id,
                serverName: server.name,
                sourceId: primarySource.id,
            });
        }

        configs.push({
            id: server.id,
            name: server.name,
            gameAddress: server.gameAddress,
            sources,
            primarySource,
        });
    }

    return {configs, notices};
}

//Меньший priority — важнее. id добивает ничью: без него порядок при равных приоритетах задавала бы
//выдача хранилища, то есть он был бы недетерминированным и разным у разных реализаций.
//toSorted, а не sort: входной массив принадлежит вызывающему.
function sortByPriority(sources: readonly ServerQuerySource[]): ServerQuerySource[] {
    return sources.toSorted((left, right) => left.priority - right.priority || left.id - right.id);
}
