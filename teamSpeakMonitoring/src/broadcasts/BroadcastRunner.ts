import type {Logger} from "pino";
import type {BroadcastDelivery, BroadcastStore, DeliveryCounts, StoredBroadcast} from "./Broadcasts.js";

//Отчёт автору по окончании рассылки — через тот же транспорт, но текстом от бота.
export type BroadcastReporter = (broadcast: StoredBroadcast, counts: DeliveryCounts) => Promise<void>;

//Рассылка уже подтверждённой рассылки: адресаты на момент запуска, по одному, итог каждого — в базу.
//
//Запускается в фоне, мимо обработчика кнопки: большая рассылка дольше дедлайна апдейта
//(TELEGRAM_UPDATE_TIMEOUT_MS), и ждать её значило бы бросить на полпути. Частоту держит общий
//TelegramSender — тот же, что у уведомлений, поэтому рассылка лимит Bot API не превысит.
//
//Сбой записи итога одного чата не останавливает рассылку: сообщение уже ушло, а остальным
//оно нужно не меньше. Сбой целиком (база недоступна при старте) — в лог; рассылка останется
//sending и при следующем старте процесса станет interrupted.
export class BroadcastRunner {
    constructor(
        private readonly store: BroadcastStore,
        private readonly delivery: BroadcastDelivery,
        private readonly report: BroadcastReporter,
        private readonly logger: Logger,
    ) {
    }

    public async run(broadcast: StoredBroadcast): Promise<DeliveryCounts> {
        const recipients = await this.store.resolveRecipients(broadcast.target);
        const counts: DeliveryCounts = {recipients: recipients.length, delivered: 0, blocked: 0, failed: 0};

        this.logger.info({broadcastId: broadcast.id, recipients: recipients.length}, "Рассылка начата");

        for (const chatId of recipients) {
            const outcome = await this.delivery.deliver(chatId, broadcast.content);

            counts[outcome.status]++;

            await this.store.recordDelivery(broadcast.id, chatId, outcome).catch((error: unknown) => {
                this.logger.warn({error, broadcastId: broadcast.id, chatId}, "Не удалось записать итог доставки рассылки");
            });
        }

        await this.store.finishBroadcast(broadcast.id, counts);
        this.logger.info({broadcastId: broadcast.id, ...counts}, "Рассылка завершена");

        await this.report(broadcast, counts).catch((error: unknown) => {
            this.logger.warn({error, broadcastId: broadcast.id}, "Не удалось отправить отчёт о рассылке");
        });

        return counts;
    }
}
