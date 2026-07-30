import type {ServerDescriptionView} from "../a2s/ServerMonitor.js";
import type {ServerSnapshot} from "../a2s/ServerProbe.js";
import type {Logger} from "pino";


export type NotificationEvent =
    | { type: "statusViewChanged"; view: ServerDescriptionView[] }
    | { type: "serverOnline"; snapshot: ServerSnapshot }
    | { type: "serverOffline"; snapshot: ServerSnapshot };

export type NotificationEventType = NotificationEvent["type"];

//Канал доставки. Ресурсами (соединения, боты) владеет composition root, поэтому close() здесь нет.
export interface NotificationHandler {
    notify(event: NotificationEvent): Promise<void>;
}

//Что на какое событие подписано. Список собирается в main.ts: там видно всю систему целиком.
//name нужен только логам — без него непонятно, какой именно канал отказал.
export interface NotificationSubscription {
    event: NotificationEventType;
    name: string;
    handler: NotificationHandler;
}

//Диспетчер, и только диспетчер: раздаёт событие всем подписанным на его тип хендлерам.
//Сам ничего не создаёт, про конфигурацию, адресатов и протоколы доставки не знает.
export class NotificationDispatcher {
    private readonly subscriptionsByEvent = new Map<NotificationEventType, NotificationSubscription[]>();

    constructor(
        subscriptions: readonly NotificationSubscription[],
        private readonly logger: Logger,
    ) {
        for (const subscription of subscriptions) {
            const forEvent = this.subscriptionsByEvent.get(subscription.event) ?? [];
            forEvent.push(subscription);
            this.subscriptionsByEvent.set(subscription.event, forEvent);
        }
    }

    public async notify(event: NotificationEvent): Promise<void> {
        const subscriptions = this.subscriptionsByEvent.get(event.type) ?? [];

        //Отказ одного канала не должен ронять остальные, но и молчать о нём нельзя.
        const results = await Promise.allSettled(
            subscriptions.map(subscription => subscription.handler.notify(event)),
        );

        results.forEach((result, index) => {
            if (result.status !== "rejected") {
                return;
            }

            this.logger.warn(
                {
                    error: result.reason,
                    handler: subscriptions[index]?.name,
                    event: event.type,
                },
                "Notification handler failed",
            );
        });
    }
}
