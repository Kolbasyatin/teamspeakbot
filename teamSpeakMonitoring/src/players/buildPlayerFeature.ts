import type {Logger} from "pino";
import type {ScheduledTask} from "../monitoring/Scheduler.js";
import type {BotCommands} from "../telegram/TelegramBot.js";
import {PlayerCommands, type ChatRegistry, type PlayerSubscriptionStore} from "../telegram/PlayerCommands.js";
import {PlayerEventPoller, type PlayerEventSink, type PlayerEventStore} from "./PlayerEventPoller.js";
import {PendingSubscriptionResolver, type PendingSubscriptionStore} from "./PendingSubscriptionResolver.js";
import {PlayerObserverClient} from "./PlayerObserverClient.js";
import {renderEvent} from "../telegram/PlayerMessages.js";
import type {PlayerEvent} from "./PlayerObserver.js";

export interface PlayerFeatureProperties {
    baseUrl: string;
    apiToken: string;
    timeoutMs: number;
    dossierTimeoutMs: number;
    eventIntervalMs: number;
    eventPageSize: number;
    pendingIntervalMs: number;
    pendingTtlMs: number;
    pendingLimit: number;
}

//Хранилище целиком: один репозиторий закрывает все три узких интерфейса, каждый из которых
//объявлен у своего потребителя.
export type PlayerStore = PlayerSubscriptionStore & PlayerEventStore & PendingSubscriptionStore;

//Отправка текста в чат. Та же форма, что у MessageSender в TelegramStatusNotifier: про grammy
//и разметку здесь не знают.
export interface ChatSender {
    send(chatId: number, text: string): Promise<void>;
}

//Всё, что даёт наблюдение за игроками: набор команд для бота и фоновые задачи для планировщика.
export interface PlayerFeature {
    commands: BotCommands;
    tasks: ScheduledTask[];
}

//Сборка одной темы одним вызовом: в composition root от неё остаются две строки, а не два десятка.
//Отдельный файл, а не кусок main.ts, потому что тема связная и у неё есть имя — ровно то,
//что §8 п. 25 AGENTS.md предлагает делать с разросшимся main.
//
//Пустой baseUrl ИЛИ пустой токен означают «наблюдателя нет»: возвращаем undefined, и бот просто
//не получает ни команд про игроков, ни фоновых задач. Мониторинг серверов работает как прежде.
//Токен проверяется наравне с адресом намеренно: с адресом, но без токена сосед отвечает 401
//на каждый запрос, и лента засыпала бы лог предупреждениями каждые пятнадцать секунд.
export function buildPlayerFeature(
    properties: PlayerFeatureProperties,
    store: PlayerStore,
    chats: ChatRegistry,
    sender: ChatSender,
    logger: Logger,
    now: () => Date = () => new Date(),
): PlayerFeature | undefined {
    if (properties.baseUrl === "" || properties.apiToken === "") {
        return undefined;
    }

    const observer = new PlayerObserverClient(properties);

    //Событие превращается в текст здесь: поллер знает про адресатов, но не про то,
    //как выглядит сообщение.
    const eventSink: PlayerEventSink = {
        deliver: async (chatId: number, event: PlayerEvent): Promise<void> => {
            const text = renderEvent(event);

            //Тип события, о котором бот рассказывать не умеет (новый у соседа), пропускается молча:
            //строка «PLAYER_XXX» в чате хуже тишины.
            if (text === undefined) {
                return;
            }

            await sender.send(chatId, text);
        },
    };

    const commands = new PlayerCommands(observer, store, chats, {
        pendingTtlMs: properties.pendingTtlMs,
        pendingLimit: properties.pendingLimit,
    }, logger, now);

    const events = new PlayerEventPoller(observer, store, eventSink, {
        intervalMs: properties.eventIntervalMs,
        pageSize: properties.eventPageSize,
    }, logger);

    const pending = new PendingSubscriptionResolver(observer, store, {
        deliver: (chatId, text) => sender.send(chatId, text),
    }, {intervalMs: properties.pendingIntervalMs}, logger, now);

    return {commands, tasks: [events, pending]};
}
