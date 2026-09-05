import {ServerProbe, type ServerProbeSnapshot, type ServerStatus} from "./ServerProbe.js";
import {EventEmitter} from "node:events";
import type {ServerMonitorConfig} from "./MonitoredServer.js";
import type {Querier, QuerierRegistry, ServerPollResult, ServerQueryConfig} from "./ServerQuery.js";
import {pollServerSources} from "./pollServerSources.js";
import {SecondarySourceThrottle} from "./SecondarySourceThrottle.js";
import {type ScheduledTask, Scheduler} from "./Scheduler.js";
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

    public constructor(
        private readonly options: MonitorProperties,
        private readonly logger: Logger,
        //Реализации опроса приходят из composition root: монитору незачем знать ни про A2S,
        //ни про REST, ни про то, что появится дальше.
        private readonly queriers: QuerierRegistry,
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
        this.logger.debug(`Poll сервера ${probe.getServerName()} с периодом ${this.getNextPollDelayMs(probe)} мс.`);
        const config: ServerMonitorConfig = probe.getSnapshot().config;
        //Монитор знает, каким querier'ом опрашивать источник; сколько кого ждать и как сводить
        //ответы — дело pollServerSources; как часто беспокоить второстепенные — троттлинга.
        const result = await pollServerSources(
            config,
            this.secondaryThrottle.wrap(
                source => this.getQuerier(source.query.type).query(source.query),
                config,
            ),
            this.options.secondaryGraceMs,
            this.logger,
        );

        probe.handleResult(result);
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

        //Тут добавляем недостающие
        for (const server of servers) {
            if (this.probes.has(server.id)) {
                continue;
            }

            const probe = this.createServerProbe(server);

            probe.on("online", this.handleProbeOnline)
            probe.on("offline", this.handleProbeOffline)

            this.probes.set(server.id, probe);
        }
        //Синк с шедулером
        this.scheduler.sync(this.getScheduledTasks());
        this.secondaryThrottle.retain(servers);
    }

    public stop(): void {
        this.scheduler.stop();
    }

    public getSnapshot(): ServerProbeSnapshot[] {
        return [...this.probes.values()].map(probe => probe.getSnapshot());
    }

    private readonly handleProbeOnline = (event: ServerProbeSnapshot): void => {
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

    //Взависимости от статусов, здесь  говорим что если failedChecks случился, то учащаем проверки до секунды
    // (улучшаем проблему ложного срабатывания)
    private getNextPollDelayMs(probe: ServerProbe): number {
        const snapshot = probe.getSnapshot();
        if (snapshot.status !== "offline" && snapshot.failedChecks > 0) {
            return this.options.suspiciousPollIntervalMs;
        }

        return this.options.pollIntervalMs;
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
                return this.getNextPollDelayMs(probe);
            }
        }))
    }

    private createServerProbe(server: ServerMonitorConfig): ServerProbe {
        return new ServerProbe(server, this.options.maxFailedChecks, this.logger);
    }
    
}

