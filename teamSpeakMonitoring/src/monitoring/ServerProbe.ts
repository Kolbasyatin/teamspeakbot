import type {ServerMonitorConfig} from "./MonitoredServer.js";
import type {ServerQueryResult} from "./ServerQuery.js";
import {EventEmitter} from "node:events";
import type {Logger} from "pino";

export type ServerStatus = 'online' | 'offline' | 'unknown'

export interface ServerSnapshot {
    config: ServerMonitorConfig;
    status: ServerStatus;
    failedChecks: number;
    info: ServerQueryResult | undefined;
    lastInfo: ServerQueryResult | undefined;
    statusSince: Date;
}

interface ServerStatusEvent {
    snapshot: ServerSnapshot;
    previousStatus: ServerStatus;
    currentStatus: ServerStatus;
}

export class ServerProbe extends EventEmitter {
    private status: ServerStatus = 'unknown';
    private failedChecks: number = 0;
    private lastInfo: ServerQueryResult | undefined;

    constructor(
        private readonly serverData: ServerMonitorConfig,
        private maxFailedChecks: number = 5,
        private logger: Logger,
        private statusSince: Date = new Date(),
    ) {
        super();
    }

    public handleResult(result: ServerQueryResult | undefined): void {
        const previousStatus = this.status;
        const previousInfo = this.lastInfo;
        //Статус сервера определяется только лишь тем, пришел ли ответ. Если да, то он точно online
        if (result) {
            this.statusSuccess(result);
        } else {
            this.statusFailure();
        }

        this.commitChanges(previousStatus, previousInfo);
    }

    public getSnapshot(): ServerSnapshot {
        return {
            config: this.serverData,
            status: this.status,
            failedChecks: this.failedChecks,
            info: this.status === 'online' ? this.lastInfo : undefined,
            lastInfo: this.lastInfo,
            statusSince: this.statusSince,
        };
    }

    private statusSuccess(result: ServerQueryResult): void {
        this.status = 'online';
        this.failedChecks = 0;
        this.lastInfo = result;
    }

    private statusFailure() {
        //Счётчик нужен только на пути к offline, поэтому ограничен порогом:
        //иначе у давно лежащего сервера он растёт неограниченно и теряет смысл.
        this.failedChecks = Math.min(this.failedChecks + 1, this.maxFailedChecks);

        if (this.failedChecks >= this.maxFailedChecks) {
            this.status = 'offline';
        }
    }

    private commitChanges(previousServerStatus: ServerStatus, previousInfo: ServerQueryResult | undefined): void {

        if (this.lastInfo?.players !== previousInfo?.players) {
            this.emit('playersChanged', this.getSnapshot());
        }

        //Status changed!
        //FIXME: Тут грязновато немного. Я добавляю просто свойство времени действия текущего статуса statusSince,
        // хотя правильнее нужно вводить что то типа объекта ProbeState.
        if (this.isStatusChanged(this.status, previousServerStatus)) {
            this.statusSince = new Date();
            this.emitStatusEvents(previousServerStatus);
        }
    }

    private isStatusChanged(currentStatus: ServerStatus, previousStatus: ServerStatus): boolean {
        return currentStatus !== previousStatus;
    }

    private emitStatusEvents(previousServerStatus: ServerStatus): void {
        //Тут пока несрастуха. Зачем собирать сообщение чтоб потом из него забирать одно поле... еще не знаю сам.
        const event: ServerStatusEvent = {
            snapshot: this.getSnapshot(),
            previousStatus: previousServerStatus,
            currentStatus: this.status,
        };

        this.emit('serverStatusChanged', event.snapshot)

        if (this.status === 'online') {
            this.logger.debug(`${this.serverData.name} is online`)
            this.emit('online', event.snapshot);
        }

        if (this.status === 'offline') {
            this.logger.debug(`${this.serverData.name} is offline`)
            this.emit('offline', event.snapshot);
        }
    }
    
    public getServerName(): string {
        return this.serverData.name;
    }

}
