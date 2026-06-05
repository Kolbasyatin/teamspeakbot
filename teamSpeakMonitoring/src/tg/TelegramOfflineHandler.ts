import type {NotificationEvent, NotificationHandler} from "../Notifiers/Notifiers.js";
import type {TelegramSender} from "./TelegramSender.js";

export class TelegramOfflineHandler implements NotificationHandler {
    constructor(
        private readonly sender: TelegramSender,
        private readonly activeFlag: boolean,
    ) {
    }

    public async notify(event: NotificationEvent): Promise<void> {
        if (event.type !== "serverOffline") {
            return;
        }
        await this.sender.send(`${event.snapshot.config.name} is offline`);
    }

    public async close(): Promise<void> {
        return;
    }

    isActive(): boolean {
        return this.activeFlag;
    }
}
