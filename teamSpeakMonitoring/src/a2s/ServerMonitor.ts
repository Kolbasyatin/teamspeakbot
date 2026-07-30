import {ServerProbe, type ServerSnapshot, type ServerStatus} from "./ServerProbe.js";
import {EventEmitter} from "node:events";
import type {ServerMonitorConfig, ServerQueryConfig} from "./config.js";
import {type ServerInfo} from "@callowayisweird/source-query";
import {log} from "../logger.js";
import {A2sQuerier} from "../queriers/A2sQuerier.js";
import {RestQuerier} from "../queriers/RestQuerier.js";
import {type ScheduledTask, Scheduler} from "./ProbeScheduler.js";
import {type MonitorProperties} from "../properties.js";
import type {Logger} from "pino";


export type ServerDescriptionView = {
    id: number;
    name: string;
    status: ServerStatus;
    players?: number | undefined;
    maxPlayers?: number | undefined;
};

export interface Querier {
    query(config: ServerQueryConfig): Promise<ServerInfo | undefined>;
}

export class ServerMonitor extends EventEmitter {

    private lastViewKey?: string;
    private readonly probes = new Map<number, ServerProbe>();
    private readonly queriers = new Map<ServerQueryConfig["type"], Querier>([
        ["a2s", new A2sQuerier()],
        ["rest", new RestQuerier()]
    ])
    //Создаётся в конструкторе, а не инициализатором поля: инициализаторы полей выполняются
    //раньше, чем присваиваются параметры-свойства, и logger там был бы ещё undefined.
    private readonly scheduler: Scheduler<ScheduledTask>;

    public constructor(
        private options: MonitorProperties,
        private logger: Logger
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
        const result: ServerInfo | undefined = await this.getQuerier(config.query.type).query(config.query);
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

    private readonly handleProbeOnline = (event: ServerSnapshot): void => {
        this.emit("serverOnline", event);
    };

    private readonly handleProbeOffline = (event: ServerSnapshot): void => {
        this.emit("serverOffline", event);
    };

    private emitChangedIfNeeded(): void {
        const view = this.toDescriptionView(this.getSnapshot());
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

    private getQuerier(type: ServerQueryConfig["type"]): Querier {
        const querier = this.queriers.get(type);

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

