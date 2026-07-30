import type {NotificationEvent, NotificationHandler} from "./events.js";
import type {Logger} from "pino";

export class LogNotifier implements NotificationHandler {
    constructor(private readonly logger: Logger) {
    }

    public async notify(event: NotificationEvent): Promise<void> {
        if (event.type !== "statusViewChanged") {
            return;
        }

        this.logger.info({view: event.view}, "Событие statusViewChanged");
    }
}
