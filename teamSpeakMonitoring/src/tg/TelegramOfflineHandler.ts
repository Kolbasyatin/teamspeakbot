import type {NotificationEvent, NotificationHandler} from "../Notifiers/NotificationDispatcher.js";
import type {TelegramSender} from "./TelegramSender.js";

export class TelegramOfflineHandler implements NotificationHandler {
    constructor(private readonly sender: TelegramSender) {
    }

    public async notify(event: NotificationEvent): Promise<void> {
        if (event.type !== "serverOffline") {
            return;
        }
        await this.sender.send(`${event.snapshot.config.name} is offline`);
    }
}
