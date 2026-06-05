import type {NotificationEvent, NotificationHandler} from "../Notifiers/Notifiers.js";
import type {TelegramSender} from "./TelegramSender.js";

export class TelegramOnlineHandler implements NotificationHandler {
    constructor(
        private readonly sender: TelegramSender,
        private readonly activeFlag: boolean,
    ) {
    }

    public async notify(event: NotificationEvent): Promise<void> {
        if (event.type !== "serverOnline") {
            return;
        }
        await this.sender.send(`${event.snapshot.config.name} is online`);
    }

    public async close(): Promise<void> {
        return;
    }

    isActive(): boolean {
        return this.activeFlag;
    }

}