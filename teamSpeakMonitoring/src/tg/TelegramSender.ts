import type {Bot} from "grammy";

//Транспорт: единственное место, которое знает, как отправить текст в Telegram.
//Ошибку не гасит и не логирует сам — её увидит и залогирует NotificationDispatcher, вместе с именем канала.
//TODO: адресат станет параметром send(), когда бот научится писать конкретным пользователям —
//итерация 5, вместе с политикой уведомлений.
export class TelegramSender {
    constructor(
        private readonly bot: Bot,
        private readonly chatId: string,
    ) {
    }

    public async send(text: string): Promise<void> {
        await this.bot.api.sendMessage(this.chatId, text);
    }
}
