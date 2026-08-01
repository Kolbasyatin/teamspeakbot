import type {ServerMonitorConfig} from "./MonitoredServer.js";
import type {ServerPollResult, ServerQueryResult} from "./ServerQuery.js";
import {EventEmitter} from "node:events";
import type {Logger} from "pino";

export type ServerStatus = 'online' | 'offline' | 'unknown'

//Слепок состояния probe для внешнего мира. Данные здесь ровно одни — те, за которые ручается
//текущий статус: у сервера не online их нет, и взять протухшее значение снаружи невозможно.
//Пережившие падение данные остаются приватными внутри probe — потребителя у них нет, а появится
//(«было 12 игроков 6 минут назад»), поле вернётся вместе с отметкой времени: без неё оно бесполезно.
export interface ServerSnapshot {
    config: ServerMonitorConfig;
    status: ServerStatus;
    failedChecks: number;
    currentInfo: ServerQueryResult | undefined;
    statusSince: Date;
}

//Карта событий: имена и типы аргументов проверяются компилятором, опечатка больше не даст
//тихого no-op. Событий ровно два — только переходы статуса, на которые есть подписчики.
export interface ServerProbeEvents {
    online: [ServerSnapshot];
    offline: [ServerSnapshot];
}

export class ServerProbe extends EventEmitter<ServerProbeEvents> {
    private status: ServerStatus = 'unknown';
    private failedChecks: number = 0;
    //Последние успешно полученные данные. Живут дольше одного опроса намеренно: пока сервер
    //в дребезге (неудачи есть, но порога не достигли), он ещё считается online и показывать
    //надо их. Наружу отдаются только через currentInfo, то есть пока статус это подтверждает.
    private lastKnownInfo: ServerQueryResult | undefined;

    constructor(
        private readonly serverData: ServerMonitorConfig,
        private maxFailedChecks: number = 5,
        private logger: Logger,
        private statusSince: Date = new Date(),
    ) {
        super();
    }

    public handleResult(result: ServerPollResult): void {
        const previousStatus = this.status;
        //Статус сервера определяется только лишь тем, ответил ли ГЛАВНЫЙ источник. Если да,
        //то сервер точно online. Данные второстепенных источников на статус не влияют:
        //их молчание означает "поле неизвестно", а не "сервер лёг".
        if (result.alive) {
            this.statusSuccess(result.info);
        } else {
            this.statusFailure();
        }

        this.commitChanges(previousStatus);
    }

    public getSnapshot(): ServerSnapshot {
        return {
            config: this.serverData,
            status: this.status,
            failedChecks: this.failedChecks,
            currentInfo: this.status === 'online' ? this.lastKnownInfo : undefined,
            statusSince: this.statusSince,
        };
    }

    private statusSuccess(result: ServerQueryResult): void {
        this.status = 'online';
        this.failedChecks = 0;
        this.lastKnownInfo = result;
    }

    private statusFailure() {
        //Счётчик нужен только на пути к offline, поэтому ограничен порогом:
        //иначе у давно лежащего сервера он растёт неограниченно и теряет смысл.
        this.failedChecks = Math.min(this.failedChecks + 1, this.maxFailedChecks);

        if (this.failedChecks >= this.maxFailedChecks) {
            this.status = 'offline';
        }
    }

    private commitChanges(previousServerStatus: ServerStatus): void {
        //FIXME: Тут грязновато немного. Я добавляю просто свойство времени действия текущего статуса statusSince,
        // хотя правильнее нужно вводить что то типа объекта ProbeState.
        if (this.isStatusChanged(this.status, previousServerStatus)) {
            this.statusSince = new Date();
            this.emitStatusEvents();
        }
    }

    private isStatusChanged(currentStatus: ServerStatus, previousStatus: ServerStatus): boolean {
        return currentStatus !== previousStatus;
    }

    private emitStatusEvents(): void {
        const snapshot = this.getSnapshot();

        if (this.status === 'online') {
            this.logger.debug(`${this.serverData.name} is online`)
            this.emit('online', snapshot);
        }

        if (this.status === 'offline') {
            this.logger.debug(`${this.serverData.name} is offline`)
            this.emit('offline', snapshot);
        }
    }
    
    public getServerName(): string {
        return this.serverData.name;
    }

}
