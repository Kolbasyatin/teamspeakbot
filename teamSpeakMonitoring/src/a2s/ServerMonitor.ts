import {ServerProbe, type ServerSnapshot, type ServerStatus} from "./ServerProbe.js";
import {EventEmitter} from "node:events";
import type {ServerMonitorConfig, ServerQueryConfig} from "./config.js";
import {type ServerInfo} from "@callowayisweird/source-query";
import {log} from "../logger.js";
import {A2sQuerier} from "../queriers/A2sQuerier.js";
import {RestQuerier} from "../queriers/RestQuerier.js";


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
    private interval: NodeJS.Timeout | undefined;
    private readonly probes = new Map<number, ServerProbe>();
    private readonly queriers = new Map<ServerQueryConfig["type"], Querier>([
        ["a2s", new A2sQuerier()],
        ["rest", new RestQuerier()]
    ])

    public constructor() {
        super();
    }

    //TODO: перевести на цикл с setTimeout . Потенциально tick может задержаться и следующий будет
    //наваливаться на предыдущий.
    public async start(): Promise<void> {
        void await this.tick();
        this.interval = setInterval(() => {
            void this.tick();
        }, 5_000);
    }


    public forceSync(servers: ServerMonitorConfig[]) {
        for (const probe of this.probes.values()) {
            probe.off("online", this.handleProbeOnline);
            probe.off("offline", this.handleProbeOffline);
        }
        this.probes.clear();

        for (const server of servers) {
            //TODO: внести в настройки maxFailedCheck
            const probe = new ServerProbe(server, 2);

            probe.on("online", this.handleProbeOnline)
            probe.on("offline", this.handleProbeOffline)

            this.probes.set(server.id, probe);
        }

    }


    //TODO: при большом таймауте между tick может возникнуть ситуация когда после добавление серверов пройдет много времени
    //посмотреть на предмет requestTick, который запустит poll вне очереди.
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

            const probe = new ServerProbe(server, 2);

            probe.on("online", this.handleProbeOnline)
            probe.on("offline", this.handleProbeOffline)

            this.probes.set(server.id, probe);
        }
    }

    public stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
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

    private async tick(): Promise<void> {
        await this.pollAll();
        this.emitChangedIfNeeded();

    }

    private emitChangedIfNeeded(): void {
        const view = this.toDescriptionView(this.getSnapshot());
        const viewKey = JSON.stringify(view);
        log.debug(viewKey);

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

    private async pollAll(): Promise<void> {
        await Promise.all(
            [...this.probes.values()].map(probe => this.pollProbe(probe))
        )
    }

    private async pollProbe(probe: ServerProbe): Promise<void> {
        const config: ServerMonitorConfig = probe.getSnapshot().config;
        const result: ServerInfo | undefined = await this.getQuerier(config.query.type).query(config.query);
        probe.handleResult(result);
    }

    private getQuerier(type: ServerQueryConfig["type"]): Querier {
        const querier = this.queriers.get(type);

        if (!querier) {
            throw new Error(`Unsupported query type: ${type}`);
        }

        return querier;
    }

}

