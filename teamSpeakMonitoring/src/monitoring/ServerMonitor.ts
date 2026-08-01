import {ServerProbe, type ServerSnapshot, type ServerStatus} from "./ServerProbe.js";
import {EventEmitter} from "node:events";
import type {ServerMonitorConfig} from "./MonitoredServer.js";
import type {Querier, QuerierRegistry, ServerQueryConfig} from "./ServerQuery.js";
import {pollServerSources} from "./pollServerSources.js";
import {type ScheduledTask, Scheduler} from "./Scheduler.js";
import {type MonitorProperties} from "../properties.js";
import type {Logger} from "pino";


export type ServerDescriptionView = {
    id: number;
    name: string;
    status: ServerStatus;
    players?: number | undefined;
    maxPlayers?: number | undefined;
};

//Карта событий монитора. Словарь свой, не общий с уведомлениями: монитор не должен знать,
//что его события кто-то куда-то доставляет. Перевод в NotificationEvent делает composition root.
//Что проверяет компилятор: типы аргументов у emit и listener'а. Чего НЕ проверяет: неизвестное
//имя события — типы Node в этом случае откатываются на any[], и опечатка в on(...) остаётся
//тихим no-op. Сузить переопределением on() не выходит: сигнатура становится несовместимой
//с базовой (TS2416). См. AGENTS.md, п. 23.
export interface ServerMonitorEvents {
    viewChanged: [ServerDescriptionView[]];
    serverOnline: [ServerSnapshot];
    serverOffline: [ServerSnapshot];
}

export class ServerMonitor extends EventEmitter<ServerMonitorEvents> {

    private lastViewKey?: string;
    private readonly probes = new Map<number, ServerProbe>();
    //Создаётся в конструкторе, а не инициализатором поля: инициализаторы полей выполняются
    //раньше, чем присваиваются параметры-свойства, и logger там был бы ещё undefined.
    private readonly scheduler: Scheduler<ScheduledTask>;

    public constructor(
        private readonly options: MonitorProperties,
        private readonly logger: Logger,
        //Реализации опроса приходят из composition root: монитору незачем знать ни про A2S,
        //ни про REST, ни про то, что появится дальше.
        private readonly queriers: QuerierRegistry,
    ) {
        super();
        this.scheduler = new Scheduler<ScheduledTask>(this.logger);
    }
    
    public start(): void {
        this.scheduler.sync(this.getScheduledTasks());
        this.scheduler.start();
    }

    private async pollProbe(probe: ServerProbe): Promise<void> {
        this.logger.debug(`Poll сервера ${probe.getServerName()} с периодом ${this.getNextPollDelayMs(probe)} мс.`);
        const config: ServerMonitorConfig = probe.getSnapshot().config;
        //Монитор знает, каким querier'ом опрашивать источник; сколько кого ждать и как сводить
        //ответы — дело pollServerSources.
        const result = await pollServerSources(
            config,
            source => this.getQuerier(source.query.type).query(source.query),
            this.options.secondaryGraceMs,
            this.logger,
        );

        probe.handleResult(result);
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
    }

    public stop(): void {
        this.scheduler.stop();
    }

    public getSnapshot(): ServerSnapshot[] {
        return [...this.probes.values()].map(probe => probe.getSnapshot());
    }

    //Текущий вид по запросу. Нужен периодической синхронизации состояния: она публикует то же,
    //что уходит в событии viewChanged, и собирать вид второй раз снаружи нельзя — разъедется.
    public getView(): ServerDescriptionView[] {
        return this.toDescriptionView(this.getSnapshot());
    }

    private readonly handleProbeOnline = (event: ServerSnapshot): void => {
        this.emit("serverOnline", event);
    };

    private readonly handleProbeOffline = (event: ServerSnapshot): void => {
        this.emit("serverOffline", event);
    };

    private emitChangedIfNeeded(): void {
        const view = this.getView();
        const viewKey = JSON.stringify(view);
        this.logger.debug(viewKey);
        if (viewKey === this.lastViewKey) {
            return;
        }
        this.lastViewKey = viewKey;
        this.emit("viewChanged", view);
    }

    private toDescriptionView(snapshot: ServerSnapshot[]): ServerDescriptionView[] {
        return snapshot.map(server => ({
            id: server.config.id,
            name: server.config.name,
            status: server.status,
            players: server.lastInfo?.players,
            maxPlayers: server.lastInfo?.maxPlayers,
        }));
    }

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
                this.emitChangedIfNeeded();
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

