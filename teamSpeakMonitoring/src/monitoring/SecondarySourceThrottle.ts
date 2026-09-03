import type {ServerMonitorConfig} from "./MonitoredServer.js";
import type {SourceQueryRunner} from "./pollServerSources.js";
import type {ServerQueryResult} from "./ServerQuery.js";

//Второстепенные источники опрашиваются реже главного, но тик остаётся целостным.
//
//Зачем. Главный (A2S) бьёт прямо в игровой сервер и может ходить каждые 5 секунд, а в режиме
//подозрения — каждую секунду. Второстепенный (каталог Bohemia) — чужой бэкенд с неизвестными
//лимитами, и данные там обновляются heartbeat'ом раз в десятки секунд: чаще спрашивать нечего.
//
//Как. Шедулер не трогаем: тик сервера один, все источники стартуют в нём вместе, главный ждёт
//второстепенных то же grace-окно. Отличие одно: второстепенный, опрошенный меньше intervalMs
//назад, не спрашивается заново — в слияние подставляется его ПРОШЛЫЙ ответ. Без подстановки
//очередь мигала бы в табло на каждом тике без опроса. Свежесть этого ответа потребитель видит
//по dataUpdatedAt, если источник его отдаёт.
//
//Отсюда же ответ на «главный раз в 40 секунд, второстепенный раз в 30»: второстепенный
//опрашивается на каждом тике, потому что к тику его интервал уже истёк. Интервал второстепенного —
//нижняя граница, а не расписание.
//
//Помнится promise, а не значение: пока запрос висит, следующий тик получает тот же висящий promise,
//и grace-окно решает, дождаться ли. Отвергнутый promise забывается сразу — иначе одна ошибка
//повторялась бы в лог каждый тик до конца интервала, а повторить запрос было бы нельзя.
//
//Отдельный класс, а не ветка в pollServerSources: та функция чистая от тика к тику, а здесь
//память между тиками — и она принадлежит монитору, который живёт столько же, сколько probes.
export class SecondarySourceThrottle {
    private readonly recent = new Map<number, {startedAt: number; result: Promise<ServerQueryResult | undefined>}>();

    constructor(
        private readonly intervalMs: number,
        private readonly now: () => number = Date.now,
    ) {
    }

    public wrap(run: SourceQueryRunner, config: ServerMonitorConfig): SourceQueryRunner {
        return source => {
            //Главный опрашивается всегда: это он определяет статус. Нулевой интервал выключает
            //троттлинг целиком — поведение «все источники каждый тик», как было до него.
            if (source.id === config.primarySource.id || this.intervalMs <= 0) {
                return run(source);
            }

            const previous = this.recent.get(source.id);

            if (previous && this.now() - previous.startedAt < this.intervalMs) {
                return previous.result;
            }

            const result = run(source);

            this.recent.set(source.id, {startedAt: this.now(), result});
            result.catch(() => this.recent.delete(source.id));

            return result;
        };
    }

    //Забыть источники, которых больше нет в опросе. Иначе память росла бы с каждой перестройкой
    //списка серверов, а вернувшийся под тем же id источник получил бы протухший ответ.
    public retain(configs: readonly ServerMonitorConfig[]): void {
        const alive = new Set(configs.flatMap(config => config.sources.map(source => source.id)));

        for (const sourceId of this.recent.keys()) {
            if (!alive.has(sourceId)) {
                this.recent.delete(sourceId);
            }
        }
    }
}
