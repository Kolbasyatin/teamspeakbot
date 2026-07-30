import type {NotificationEvent, Notifier} from "./events.js";
import type {TelegramSender} from "../telegram/TelegramSender.js";

export class TelegramOnlineNotifier implements Notifier {
    constructor(private readonly sender: TelegramSender) {
    }

    public async notify(event: NotificationEvent): Promise<void> {
        if (event.type !== "serverOnline") {
            return;
        }
        await this.sender.send(`${event.snapshot.config.name} is online`);
    }
}