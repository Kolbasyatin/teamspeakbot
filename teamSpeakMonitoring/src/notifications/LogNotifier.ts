import type {Notifier, NotificationEventOf} from "./events.js";
import type {Logger} from "pino";

export class LogNotifier implements Notifier<"statusViewChanged"> {
    constructor(private readonly logger: Logger) {
    }

    public async notify(event: NotificationEventOf<"statusViewChanged">): Promise<void> {
        this.logger.info({view: event.view}, "Событие statusViewChanged");
    }
}
