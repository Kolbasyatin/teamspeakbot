import type {NotificationEvent, NotificationHandler} from "../Notifiers/NotificationDispatcher.js";
import type {TelegramSender} from "./TelegramSender.js";

export class TelegramOnlineHandler implements NotificationHandler {
    constructor(private readonly sender: TelegramSender) {
    }

    public async notify(event: NotificationEvent): Promise<void> {
        if (event.type !== "serverOnline") {
            return;
        }
        await this.sender.send(`${event.snapshot.config.name} is online`);
    }
}