import type {Notifier, NotificationEventOf, NotificationEventType} from "./events.js";

//Кто подписан на сервер. Интерфейс объявлен здесь, у потребителя: рассылке нужен ровно один
//вопрос, а не весь репозиторий подписок.
export interface SubscriberSource {
    findSubscriberChatIds(serverId: number): Promise<number[]>;
}

//Обёртка, превращающая ОДНО событие про сервер в доставку КАЖДОМУ его подписчику.
//Правило доставки, а не канал: про Telegram, grammy и текст сообщения не знает ничего —
//только про то, что у сервера есть подписчики и у каждого свой нотифаер.
//
//Ключевое здесь — что нотифаер у каждого СВОЙ и живёт между событиями. Внутрь него ставится
//дедупликация, и своя память доставок нужна каждому по отдельности. Альтернатива — одна
//дедупликация снаружи и рассылка внутри — ломается на отказах: не принял один адресат из пятидесяти,
//ключ откатывается, и следующий тик отправляет сообщение всем пятидесяти повторно.
//Здесь же повтор уходит только тому, кому не дошло.
//
//Подписчики читаются на каждое событие, без кэша, и это осознанно: обслуживаются только переходы
//статуса (serverOnline/serverOffline), то есть единицы событий в час, а не поток. Кэш здесь стоил бы
//дороже запроса — его пришлось бы инвалидировать при каждой подписке.
export class PerSubscriberNotifier<TType extends NotificationEventType> implements Notifier<TType> {
    //Живёт между событиями намеренно: в этом и смысл — сохранить память дедупликации каждого чата.
    //Записи не вычищаются при отписке, поэтому подписавшийся заново не получит повтора,
    //пока статус сервера не изменится. Лечится не здесь: бот отвечает текущим статусом
    //в момент подписки (T4).
    private readonly notifiers = new Map<number, Notifier<TType>>();

    constructor(
        private readonly subscribers: SubscriberSource,
        //Про какой сервер событие. Лямбдой, потому что у разных событий поле лежит по-разному —
        //ровно как в ChangesOnlyNotifier.
        private readonly serverIdOf: (event: NotificationEventOf<TType>) => number,
        //Как собрать цепочку доставки для одного адресата. Собирает её composition root:
        //только там видно, какой транспорт и какими обёртками обёрнут.
        private readonly notifierFor: (chatId: number) => Notifier<TType>,
    ) {
    }

    public async notify(event: NotificationEventOf<TType>): Promise<void> {
        const chatIds = await this.subscribers.findSubscriberChatIds(this.serverIdOf(event));

        //Promise.all, а не allSettled: отказ обязан дойти до NotificationDispatcher и попасть в лог.
        //Дубликатов это не создаёт — у каждого адресата своя память, и успешные доставки её уже
        //записали. Обработчик навешен на все промисы сразу, поэтому вторая ошибка не станет
        //unhandled rejection.
        await Promise.all(chatIds.map(chatId => this.notifierOf(chatId).notify(event)));
    }

    private notifierOf(chatId: number): Notifier<TType> {
        const existing = this.notifiers.get(chatId);

        if (existing) {
            return existing;
        }

        const created = this.notifierFor(chatId);
        this.notifiers.set(chatId, created);

        return created;
    }
}
