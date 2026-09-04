import type {Bot} from "grammy";

//Транспорт: единственное место, которое знает, как отправить текст в Telegram.
//Ошибку не гасит и не логирует сам — её увидит и залогирует NotificationDispatcher, вместе с именем канала.
//
//Адресат — параметр send(), а не поле объекта: экземпляр один на процесс, как и сам Bot.
//Так и должно быть, потому что лимит Bot API (порядка 30 сообщений в секунду) общий на бота,
//а не на чат. Появится очередь с троттлингом — ей место здесь, и другого места у неё нет.
export class TelegramSender {
    constructor(private readonly bot: Bot) {
    }

    //chatId числом для личек и групп, строкой — для канала по @username.
    //
    //Разметка всегда HTML, как и у ответов на команды (/status, /serverlist): один режим на всё
    //исходящее, чтобы нотифаеры не договаривались с транспортом отдельно. Обратная сторона —
    //каждый, кто подставляет в текст имя сервера, обязан прогнать его через escapeHtml.
    public async send(chatId: number | string, text: string): Promise<void> {
        await this.bot.api.sendMessage(chatId, text, {parse_mode: "HTML"});
    }
}
