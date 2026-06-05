import type {NotificationEvent, NotificationHandler} from "./Notifiers.js";
import {log} from "../logger.js";

export class LogNotifier implements NotificationHandler {
    constructor(private readonly activeFlag: boolean) {
    }

    async notify(event: NotificationEvent): Promise<void> {
        if (event.type !== "statusViewChanged") {
            return;
        }
        const text = JSON.stringify(event.view);
        log.info(`Событие statusViewChanged ${text}`);
        // log.info(`Событие statusViewChanged ${event.view}`);
    }

    public close(): Promise<void> {
        return Promise.resolve(undefined);
    }

    public isActive(): boolean {
        return this.activeFlag;
    }
}
