import type {Bot} from "grammy";

//Транспорт: единственное место, которое знает, как отправить текст в Telegram.
//Ошибку не гасит и не логирует сам — её увидит и залогирует NotificationDispatcher, вместе с именем канала.
//
//Адресат — параметр send(), а не поле объекта: экземпляр один на процесс, как и сам Bot.
//Так и должно быть, потому что лимит Bot API (порядка 30 сообщений в секунду) общий на бота,
//а не на чат.
//
//ТРОТТЛИНГ. Отправки разводятся по времени: между стартами двух сообщений не меньше
//MIN_INTERVAL_MS. Появился с подписками на игроков — там массовый заход на популярный сервер
//порождает десятки уведомлений одним тиком, и без разводки Bot API отвечает 429 с retry_after,
//после чего часть сообщений теряется. Разводка глобальная, потому что и лимит глобальный.
//
//Ждём ТОЛЬКО момента старта, а не завершения предыдущей отправки: иначе один зависший запрос
//(таймаут grammy по умолчанию — сотни секунд) держал бы всю очередь, и мониторинг серверов,
//который шлёт через тот же экземпляр, замолчал бы вместе с ним.
export class TelegramSender {
    //30 сообщений в секунду — документированный потолок Bot API; берём с запасом.
    private static readonly MIN_INTERVAL_MS = 40;

    //Момент, раньше которого нельзя начинать следующую отправку.
    private nextSlotAt = 0;

    constructor(
        private readonly bot: Bot,
        //Часы отдельно от Date.now() ради теста: проверять разводку по реальному времени —
        //значит делать тест медленным и плавающим.
        private readonly now: () => number = () => Date.now(),
        private readonly sleep: (delayMs: number) => Promise<void> =
        delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
    ) {
    }

    //chatId числом для личек и групп, строкой — для канала по @username.
    //
    //Разметка всегда HTML, как и у ответов на команды (/status, /serverlist): один режим на всё
    //исходящее, чтобы нотифаеры не договаривались с транспортом отдельно. Обратная сторона —
    //каждый, кто подставляет в текст имя сервера, обязан прогнать его через escapeHtml.
    public async send(chatId: number | string, text: string): Promise<void> {
        await this.waitForSlot();
        await this.bot.api.sendMessage(chatId, text, {parse_mode: "HTML"});
    }

    //Слот занимается синхронно, до любого await: два одновременных вызова обязаны получить
    //разные слоты, а не одинаковый.
    private async waitForSlot(): Promise<void> {
        const now = this.now();
        const slot = Math.max(now, this.nextSlotAt);

        this.nextSlotAt = slot + TelegramSender.MIN_INTERVAL_MS;

        if (slot > now) {
            await this.sleep(slot - now);
        }
    }
}
