import type {Logger} from "pino";
import type {DeliveryMemory} from "./ChangesOnlyNotifier.js";

//Какой статус сервера последним доставлен в чат: serverOnline или serverOffline.
export interface StatusDelivery {
    chatId: number;
    serverId: number;
    delivered: string;
}

export interface StatusDeliveryStore {
    loadDeliveries(): Promise<StatusDelivery[]>;

    saveDelivery(delivery: StatusDelivery): Promise<void>;
}

//Память уведомлений «упал/поднялся» между рестартами (итерация 22). Читается один раз при старте,
//до первого опроса, и раздаётся по чатам: у каждого чата своя обёртка ChangesOnlyNotifier
//(см. PerSubscriberNotifier), и каждой — своя часть памяти.
//
//После рестарта бот видит, что этому чату уже сказано «online», и молчит. Сервер, упавший, пока
//бота не было, честно даст «offline»: доставлено одно, сейчас другое. Чат, которому сказать ещё
//не успели, получит своё.
//
//Предмет памяти — id сервера строкой: так его задаёт обёртка статусов в composition root.
export class StatusDeliveryJournal {
    private readonly byChat = new Map<number, Map<string, string>>();

    constructor(
        private readonly store: StatusDeliveryStore,
        private readonly logger: Logger,
    ) {
    }

    //Возвращает, сколько доставок восстановлено, — для сообщения о запуске.
    public async load(): Promise<number> {
        const deliveries = await this.store.loadDeliveries();

        this.byChat.clear();

        for (const delivery of deliveries) {
            const chat = this.byChat.get(delivery.chatId) ?? new Map<string, string>();
            chat.set(String(delivery.serverId), delivery.delivered);
            this.byChat.set(delivery.chatId, chat);
        }

        return deliveries.length;
    }

    public memoryFor(chatId: number): DeliveryMemory {
        return {
            restored: this.byChat.get(chatId) ?? new Map(),
            remember: async (subject, dedupKey) => {
                //Сообщение уже ушло: отказ записи только в лог. Цена — после следующего рестарта
                //этот чат, возможно, получит статус ещё раз.
                try {
                    await this.store.saveDelivery({chatId, serverId: Number(subject), delivered: dedupKey});
                } catch (error) {
                    this.logger.warn({error, chatId, serverId: subject}, "Не удалось сохранить доставку статуса");
                }
            },
        };
    }
}
