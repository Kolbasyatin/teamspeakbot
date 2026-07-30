import type {Logger} from "pino";
import type {
    NotificationEvent,
    NotificationEventType,
    NotificationSubscription,
} from "./events.js";

//Диспетчер, и только диспетчер: раздаёт событие всем нотифаерам, подписанным на его тип.
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
            subscriptions.map(subscription => subscription.notifier.notify(event)),
        );

        results.forEach((result, index) => {
            if (result.status !== "rejected") {
                return;
            }

            this.logger.warn(
                {
                    error: result.reason,
                    notifier: subscriptions[index]?.name,
                    event: event.type,
                },
                "Notification delivery failed",
            );
        });
    }
}
