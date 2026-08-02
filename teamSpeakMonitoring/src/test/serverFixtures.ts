import type {ServerMonitorConfig, ServerQuerySource} from "../monitoring/MonitoredServer.js";
import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";
import type {ServerProbeSnapshot, ServerStatus} from "../monitoring/ServerProbe.js";

//Готовый ServerMonitorConfig для тестов, которым он нужен целиком, но безразличен по содержанию:
//нотифаеры и probe конфиг только пересылают дальше и читают из него имя. Собирать источники руками
//в каждом таком тесте — шум, который к тому же придётся править при следующем изменении модели.
//Тесты, для которых состав источников существен (ServerMonitor, ServerRepository), строят его сами.
export function serverConfigFixture(
    overrides: {
        id?: number;
        name?: string;
        gameAddress?: string;
        query?: ServerQueryConfig;
    } = {},
): ServerMonitorConfig {
    const id = overrides.id ?? 1;
    const primarySource: ServerQuerySource = {
        id,
        role: "primary",
        priority: 0,
        query: overrides.query ?? {type: "a2s", host: "127.0.0.1", port: 27015, timeout: 5_000},
    };

    return {
        id,
        name: overrides.name ?? `Server ${id}`,
        gameAddress: overrides.gameAddress ?? "127.0.0.1:2001",
        //Тот же объект, а не копия: репозиторий собирает конфиг именно так.
        sources: [primarySource],
        primarySource,
    };
}

//Готовый снапшот probe. Нужен всем, кто стоит НИЖЕ монитора: после переноса проекции
//к потребителям уведомления получают снапшоты, и собирать их руками в каждом тесте — шум.
//players не задан — значит данных нет: так выглядит и offline, и живой сервер без полей.
export function snapshotFixture(
    overrides: {
        id?: number;
        name?: string;
        status?: ServerStatus;
        players?: number;
        maxPlayers?: number;
    } = {},
): ServerProbeSnapshot {
    const players = overrides.players;
    //Пересобираем объект, а не пробрасываем overrides целиком: exactOptionalPropertyTypes
    //отличает «ключа нет» от «ключ со значением undefined», и второе serverConfigFixture не примет.
    const config = serverConfigFixture({
        ...(overrides.id === undefined ? {} : {id: overrides.id}),
        ...(overrides.name === undefined ? {} : {name: overrides.name}),
    });

    return {
        config,
        status: overrides.status ?? "online",
        failedChecks: 0,
        currentInfo: players === undefined
            ? undefined
            : {players, maxPlayers: overrides.maxPlayers ?? 64},
        statusSince: new Date(0),
    };
}
