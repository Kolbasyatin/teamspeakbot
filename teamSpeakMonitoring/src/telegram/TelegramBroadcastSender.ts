import {GrammyError} from "grammy";
import type {BroadcastContent, BroadcastDelivery, DeliveryOutcome} from "../broadcasts/Broadcasts.js";
import {escapeHtml} from "./escapeHtml.js";

//Что рассыльщику нужно от транспорта: отправить текст и скопировать сообщение. Реализует TelegramSender.
export interface BroadcastTransport {
    send(chatId: number, html: string): Promise<void>;

    copy(chatId: number, fromChatId: number, messageId: number): Promise<void>;
}

//Отказ Telegram, после которого писать этому чату бесполезно: заблокировал бота, удалил аккаунт,
//выгнал бота из группы (403), чата больше нет (400 chat not found). Остальное — разовый сбой.
export function isPermanentRefusal(error: GrammyError): boolean {
    return error.error_code === 403 || (error.error_code === 400 && /chat not found/i.test(error.description));
}

//Доставка одному чату с разбором ответа Telegram (итерация 24). Ограничитель частоты в TelegramSender
//держит нас ниже лимита, но 429 всё равно бывает (лимит считает и уведомления, и чужие всплески):
//тогда ждём, сколько сказали, и пробуем ровно ещё раз. Сетевые обрывы до отправки повторяет
//трансформер retryUnsentRequests — сюда они приходят, только если не помогло.
export class TelegramBroadcastSender implements BroadcastDelivery {
    //Telegram просит подождать обычно секунды; дольше минуты рассылку не держим — это сбой.
    private static readonly MAX_RETRY_AFTER_S = 60;

    constructor(
        private readonly transport: BroadcastTransport,
        private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    ) {
    }

    public async deliver(chatId: number, content: BroadcastContent): Promise<DeliveryOutcome> {
        try {
            await this.attempt(chatId, content);
            return {status: "delivered"};
        } catch (error) {
            const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;

            if (error instanceof GrammyError && error.error_code === 429
                && retryAfter !== undefined && retryAfter <= TelegramBroadcastSender.MAX_RETRY_AFTER_S) {
                await this.sleep(retryAfter * 1_000);

                try {
                    await this.attempt(chatId, content);
                    return {status: "delivered"};
                } catch (retryError) {
                    return outcomeOf(retryError);
                }
            }

            return outcomeOf(error);
        }
    }

    private async attempt(chatId: number, content: BroadcastContent): Promise<void> {
        if (content.kind === "copy") {
            await this.transport.copy(chatId, content.fromChatId, content.messageId);
            return;
        }

        //Текст из команды — как набран, без разметки: экранируем, а не доверяем.
        await this.transport.send(chatId, escapeHtml(content.text));
    }
}

function outcomeOf(error: unknown): DeliveryOutcome {
    if (error instanceof GrammyError) {
        const text = `${error.error_code}: ${error.description}`.slice(0, 255);
        return isPermanentRefusal(error) ? {status: "blocked", error: text} : {status: "failed", error: text};
    }

    return {status: "failed", error: String(error instanceof Error ? error.message : error).slice(0, 255)};
}
