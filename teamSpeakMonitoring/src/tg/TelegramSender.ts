import {Bot} from "grammy";
import {log} from "../logger.js";

export class TelegramSender {
    constructor(
        private readonly bot: Bot,
        private readonly chatId: string
    ) {
    }

    public async send(text: string): Promise<void> {
        try {
            await this.bot.api.sendMessage(this.chatId, text);
        } catch (error) {
            log.error(`Failed to send telegram message: ${error}`);
            throw error;
        }
    }

    public async close(): Promise<void> {
    }
}