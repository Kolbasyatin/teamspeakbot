import {ServerProbe, type ServerProbeSnapshot, type ServerStatus} from "./ServerProbe.js";
import {EventEmitter} from "node:events";
import type {ServerMonitorConfig} from "./MonitoredServer.js";
import type {Querier, QuerierRegistry, ServerPollResult, ServerQueryConfig} from "./ServerQuery.js";
import {pollServerSources} from "./pollServerSources.js";
import {SecondarySourceThrottle} from "./SecondarySourceThrottle.js";
import {type ScheduledTask, Scheduler} from "./Scheduler.js";
import {planPoll, type PollPlan} from "./PollPolicy.js";
import {type MonitorProperties} from "../properties.js";
import type {Logger} from "pino";


//Карта событий монитора. Словарь свой, не общий с уведомлениями: монитор не должен знать,
//что его события кто-то куда-то доставляет. Перевод в NotificationEvent делает composition root.
//Что проверяет компилятор: типы аргументов у emit и listener'а. Чего НЕ проверяет: неизвестное
//имя события — типы Node в этом случае откатываются на any[], и опечатка в on(...) остаётся
//тихим no-op. Сузить переопределением on() не выходит: сигнатура становится несовместимой
//с базовой (TS2416). См. AGENTS.md, п. 23.
//
//stateUpdated эмитится ПОСЛЕ КАЖДОГО опроса, безусловно, и несёт сырые снапшоты. Раньше на его
//месте был viewChanged: монитор сам проецировал состояние в пять полей описания канала TeamSpeak
//и сам решал по их сравнению, стоит ли будить подписчиков. То есть знал форму чужого вывода —
//добавь в проекцию поле, которого нет в описании, и TeamSpeak начал бы переписывать канал зря.
//Теперь монитор сообщает факт «серверы опрошены, вот состояние», а что из него нарисовать
//и стоит ли вообще, решает каждый потребитель у себя.
export interface ServerMonitorEvents {
    stateUpdated: [ServerProbeSnapshot[]];
    serverOnline: [ServerProbeSnapshot];
    serverOffline: [ServerProbeSnapshot];
}

export class ServerMonitor extends EventEmitter<ServerMonitorEvents> {

    private readonly probes = new Map<number, ServerProbe>();
    //Создаётся в конструкторе, а не инициализатором поля: инициализаторы полей выполняются
    //раньше, чем присваиваются параметры-свойства, и logger там был бы ещё undefined.
    private readonly scheduler: Scheduler<ScheduledTask>;
    //Память «когда какой второстепенный источник опрашивался» живёт здесь, потому что живёт
    //столько же, сколько probes: pollServerSources чиста от тика к тику и помнить ничего не может.
    private readonly secondaryThrottle: SecondarySourceThrottle;
    //Серверы в режиме «ожидается простой»: id → до какого момента. Монитор не знает, ПОЧЕМУ
    //простой ожидается (сейчас — конец раунда), ему это и не нужно: основание приходит снаружи.
    private readonly watchedUntil = new Map<number, number>();

    public constructor(
        private readonly options: MonitorProperties,
        private readonly logger: Logger,
        //Реализации опроса приходят из composition root: монитору незачем знать ни про A2S,
        //ни про REST, ни про то, что появится дальше.
        private readonly queriers: QuerierRegistry,
        //Часы — только для срока режима ожидания; параметром ради тестов.
        private readonly now: () => number = Date.now,
    ) {
        super();
        this.scheduler = new Scheduler<ScheduledTask>(this.logger);
        this.secondaryThrottle = new SecondarySourceThrottle(options.secondaryPollIntervalMs);
    }
    
    public start(): void {
        this.scheduler.sync(this.getScheduledTasks());
        this.scheduler.start();
    }

    private async pollProbe(probe: ServerProbe): Promise<void> {
        //План берётся ДО опроса: таймаут нужен запросу, а порог — тому же опросу, что под этим
        //таймаутом шёл. Включись режим посреди опроса, он подействует со следующего.
        const plan = this.planFor(probe);
        const config: ServerMonitorConfig = probe.getSnapshot().config;
        this.logger.debug({plan}, `Poll сервера ${config.name}`);
        //Монитор знает, каким querier'ом опрашивать источник; сколько кого ждать и как сводить
        //ответы — дело pollServerSources; как часто беспокоить второстепенные — троттлинга.
        const result = await pollServerSources(
            config,
            this.secondaryThrottle.wrap(
                source => this.getQuerier(source.query.type).query(
                    source.id === config.primarySource.id ? capTimeout(source.query, plan.timeoutCapMs) : source.query,
                ),
                config,
            ),
            this.options.secondaryGraceMs,
            this.logger,
        );

        probe.handleResult(result, plan.maxFailedChecks);
    }

    //Разовый опрос мимо расписания и probe: результат возвращается тому, кто спросил, событий
    //не эмитится, состояние монитора не меняется. Нужен кнопке «проверить» в боте — там сервер
    //может быть никому не подписан, то есть probe у него нет и взяться ему неоткуда.
    //Тот же pollServerSources, что и в тике: все источники, главный решает alive, остальные
    //добавляют данные в grace-окне. Троттлинг второстепенных не участвует — запрос и так один.
    public checkOnce(config: ServerMonitorConfig): Promise<ServerPollResult> {
        return pollServerSources(
            config,
            source => this.getQuerier(source.query.type).query(source.query),
            this.options.secondaryGraceMs,
            this.logger,
        );
    }

    //Скоро ожидается простой сервера: опрашивать часто, с коротким таймаутом и подтверждать
    //падение быстрее (параметры — MONITOR_WATCH_*). Режим живёт watchDurationMs или до тех пор,
    //пока сервер не вернётся в online. Повторный вызов продлевает срок.
    //Зачем: после игры 1.9 A2S молчит при перезапуске меньше, чем обычный путь к offline,
    //и перезапуск перестал быть виден (telegram.md, §11).
    public watchClosely(serverId: number): void {
        const probe = this.probes.get(serverId);

        //Сервер не опрашивается — следить нечем. Не ошибка: сигнал мог прийти по серверу,
        //который только что выпал из опроса.
        if (!probe) {
            return;
        }

        const until = this.now() + this.options.watchDurationMs;

        this.watchedUntil.set(serverId, until);
        this.logger.info(
            {serverId, name: probe.getServerName(), until: new Date(until).toISOString()},
            "Ожидается простой сервера — опрашиваем часто",
        );
        //Таймер сервера взведён по обычному плану, до него может быть несколько секунд.
        this.scheduler.wake(serverId);
    }

    public forceSync(servers: ServerMonitorConfig[]) {
        for (const probe of this.probes.values()) {
            probe.off("online", this.handleProbeOnline);
            probe.off("offline", this.handleProbeOffline);
        }
        this.probes.clear();

        for (const server of servers) {
            
            const probe = this.createServerProbe(server);

            probe.on("online", this.handleProbeOnline)
            probe.on("offline", this.handleProbeOffline)

            this.probes.set(server.id, probe);
        }
        //Синк с шедулером
        this.scheduler.sync(this.getScheduledTasks());
        this.secondaryThrottle.retain(servers);
        this.retainWatches(servers);
    }

    public syncServers(servers: ServerMonitorConfig[]): void {
        const nextServerIds = new Set(servers.map(server => server.id));
        //Тут удаляем или пропускаем существующие
        for (const [serverId, probe] of this.probes) {
            if (nextServerIds.has(serverId)) {
                continue;
            }

            probe.off("online", this.handleProbeOnline);
            probe.off("offline", this.handleProbeOffline);

            this.probes.delete(serverId)
        }

        //Тут добавляем недостающие и пересоздаём изменённые. Изменённый — значит в базе поправили
        //сам сервер или его источники: старый probe опрашивал бы по старому конфигу до рестарта.
        //Пересоздаётся только он, остальные сохраняют статус, failedChecks и таймеры — ради этого
        //syncServers и существует отдельно от forceSync.
        for (const server of servers) {
            const existing = this.probes.get(server.id);

            if (existing && sameConfig(existing.getSnapshot().config, server)) {
                continue;
            }

            if (existing) {
                existing.off("online", this.handleProbeOnline);
                existing.off("offline", this.handleProbeOffline);
            }

            const probe = this.createServerProbe(server);

            probe.on("online", this.handleProbeOnline)
            probe.on("offline", this.handleProbeOffline)

            this.probes.set(server.id, probe);
        }
        //Синк с шедулером
        this.scheduler.sync(this.getScheduledTasks());
        this.secondaryThrottle.retain(servers);
        this.retainWatches(servers);
    }

    public stop(): void {
        this.scheduler.stop();
    }

    public getSnapshot(): ServerProbeSnapshot[] {
        return [...this.probes.values()].map(probe => probe.getSnapshot());
    }

    private readonly handleProbeOnline = (event: ServerProbeSnapshot): void => {
        //Вернулся после падения — простой пойман, ждать больше нечего: обычный режим.
        if (this.watchedUntil.delete(event.config.id)) {
            this.logger.info(
                {serverId: event.config.id, name: event.config.name},
                "Ожидаемый простой пойман, сервер снова online — обычный опрос",
            );
        }

        this.emit("serverOnline", event);
    };

    private readonly handleProbeOffline = (event: ServerProbeSnapshot): void => {
        this.emit("serverOffline", event);
    };

    //Проверка остаётся, несмотря на то что QuerierRegistry покрывает все варианты union:
    //query_type приходит из БД обычной строкой, и там может лежать что угодно.
    private getQuerier(type: ServerQueryConfig["type"]): Querier {
        const querier = this.queriers[type];

        if (!querier) {
            throw new Error(`Unsupported query type: ${type}`);
        }

        return querier;
    }

    //Как опрашивать этот сервер сейчас — решает политика (PollPolicy), монитор только собирает
    //для неё состояние. Раньше здесь было одно правило «была неудача — чаще»; теперь это один
    //из режимов, рядом с которым встают другие.
    private planFor(probe: ServerProbe): PollPlan {
        const snapshot = probe.getSnapshot();

        return planPoll({
            status: snapshot.status,
            failedChecks: snapshot.failedChecks,
            watched: this.isWatched(snapshot),
        }, this.options);
    }

    //Срок проверяется при чтении, а не своим таймером: план спрашивают на каждом опросе,
    //и лишний таймер на сервер ничего бы не дал.
    private isWatched(snapshot: ServerProbeSnapshot): boolean {
        const {id: serverId, name} = snapshot.config;
        const until = this.watchedUntil.get(serverId);

        if (until === undefined) {
            return false;
        }

        if (until > this.now()) {
            return true;
        }

        this.watchedUntil.delete(serverId);
        //Два разных исхода, и по логу их надо различать: сервер всё время отвечал (A2S не молчит
        //при перезапуске — режиму ловить нечего) или упал и так и не поднялся (настоящее падение).
        this.logger.info(
            {serverId, name, status: snapshot.status},
            snapshot.status === "offline"
                ? "Срок режима ожидания истёк, сервер так и не поднялся — обычный опрос"
                : "Ожидаемого простоя не случилось за отведённый срок — обычный опрос",
        );

        return false;
    }

    //Забыть режим серверов, которых больше нет в опросе: иначе вернувшийся под тем же id сервер
    //унаследовал бы чужое ожидание.
    private retainWatches(servers: readonly ServerMonitorConfig[]): void {
        const ids = new Set(servers.map(server => server.id));

        for (const serverId of this.watchedUntil.keys()) {
            if (!ids.has(serverId)) {
                this.watchedUntil.delete(serverId);
            }
        }
    }

    private getScheduledTasks(): ScheduledTask[] {
        return [...this.probes.values()].map(probe => ({
            id: probe.getSnapshot().config.id,
            run: async (): Promise<void> => {
                await this.pollProbe(probe);
                //Безусловно, без сравнения с прошлым разом: изменилось ли что-то ЗНАЧИМОЕ —
                //вопрос, ответ на который зависит от потребителя, и здесь его знать неоткуда.
                this.emit("stateUpdated", this.getSnapshot());
            },
            getNextDelayMs: (): number => {
                return this.planFor(probe).delayMs;
            }
        }))
    }

    private createServerProbe(server: ServerMonitorConfig): ServerProbe {
        return new ServerProbe(server, this.options.maxFailedChecks, this.logger);
    }
    
}

//Таймаут главного источника — не больше потолка из плана. Только уменьшает: источник, которому
//в конфиге дали меньше, своё и получит. Конфиг копируется, исходный в probe не меняется.
function capTimeout(query: ServerQueryConfig, capMs: number | undefined): ServerQueryConfig {
    if (capMs === undefined || query.timeout <= capMs) {
        return query;
    }

    return {...query, timeout: capMs};
}

//Конфиг сравнивается целиком, по содержимому: сборка из базы каждый раз даёт новые объекты,
//поэтому сравнение по ссылке считало бы изменённым всё. Порядок ключей стабилен: источники
//сортирует buildMonitorConfigs, а query_config собирает validateQueryConfig.
function sameConfig(left: ServerMonitorConfig, right: ServerMonitorConfig): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
