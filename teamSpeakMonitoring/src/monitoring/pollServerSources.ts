import type {ServerMonitorConfig, ServerQuerySource} from "./MonitoredServer.js";
import type {ServerPollResult, ServerQueryResult} from "./ServerQuery.js";
import {mergeQueryResults} from "./mergeQueryResults.js";
import type {Logger} from "pino";

//Опрос всех источников одного сервера за один тик.
//
//Правила времени. Источники стартуют одновременно, у каждого свой timeout внутри его query_config.
//Дальше ждём только главного: он определяет статус. Как только он ответил, второстепенным даётся
//graceMs и ни миллисекундой больше — кто не успел, в слиянии этого тика не участвует.
//Отсчёт именно от ответа главного, а не от начала опроса: иначе быстрые второстепенные съедали бы
//бюджет главного и тот отваливался бы по чужому таймауту.
//Главный промолчал — не ждём никого: статус всё равно неудачный, и данные второстепенных
//в этот тик не берём (см. решение в PLAN.md).
//Потолок одного тика = timeout(главного) + graceMs. Это важно, потому что Scheduler планирует
//следующий тик после завершения предыдущего: без потолка один медленный источник растягивал бы
//интервал опроса всему серверу.
//
//Отказ второстепенного источника — не событие уровня сервера: он только обедняет данные.
//Поэтому исключение из него гасится здесь. Отказ ГЛАВНОГО пробрасывается наружу: неизвестный
//query_type у него означает, что сервер опрашивать нечем, и это ловит Scheduler.

//Как выполнить запрос одного источника. Отдельным параметром, потому что выбор querier'а —
//дело монитора, а этой функции нужен только результат.
export type SourceQueryRunner = (source: ServerQuerySource) => Promise<ServerQueryResult | undefined>;

export async function pollServerSources(
    config: ServerMonitorConfig,
    run: SourceQueryRunner,
    graceMs: number,
    logger: Logger,
): Promise<ServerPollResult> {
    const secondaries = config.sources.filter(source => source.id !== config.primarySource.id);

    //Запросы уходят до первого await, то есть все параллельно.
    //.catch навешивается здесь же, а не после ответа главного: второстепенный может упасть,
    //пока мы ждём главного, и незакрытый rejection стал бы unhandled.
    const primaryQuery = run(config.primarySource);
    const secondaryQueries = new Map(
        secondaries.map(source => [source.id, runQuietly(run, source, config, logger)]),
    );

    const primaryResult = await primaryQuery;

    if (!primaryResult) {
        return {alive: false, info: {}};
    }

    const answers = new Map<number, ServerQueryResult | undefined>();
    answers.set(config.primarySource.id, primaryResult);

    await withGrace(graceMs, async expired => {
        await Promise.all([...secondaryQueries].map(async ([sourceId, query]) => {
            answers.set(sourceId, await Promise.race([query, expired]));
        }));
    });

    //Порядок слияния — порядок sources, то есть по приоритету: побеждает первое определённое поле.
    return {
        alive: true,
        info: mergeQueryResults(config.sources.map(source => answers.get(source.id))),
    };
}

//Отказ второстепенного источника равнозначен его молчанию: данных нет, статус не при чём.
//Молча глотать нельзя — иначе опечатка в query_type второстепенного источника выглядит как
//"сервер просто не отдаёт это поле" и не находится никогда.
function runQuietly(
    run: SourceQueryRunner,
    source: ServerQuerySource,
    config: ServerMonitorConfig,
    logger: Logger,
): Promise<ServerQueryResult | undefined> {
    return run(source).catch((error: unknown) => {
        logger.warn(
            {error, serverId: config.id, name: config.name, sourceId: source.id},
            "Второстепенный источник опроса отказал — его данные в этот тик не участвуют",
        );

        return undefined;
    });
}

//Даёт задаче окно длиной graceMs, после которого expired разрешается в undefined.
//Таймер гасится в finally: иначе он держал бы event loop до конца окна даже тогда,
//когда все источники ответили мгновенно.
async function withGrace(
    graceMs: number,
    task: (expired: Promise<undefined>) => Promise<void>,
): Promise<void> {
    let timeoutId: NodeJS.Timeout | undefined;
    const expired = new Promise<undefined>(resolve => {
        timeoutId = setTimeout(() => resolve(undefined), graceMs);
    });

    try {
        await task(expired);
    } finally {
        clearTimeout(timeoutId);
    }
}
