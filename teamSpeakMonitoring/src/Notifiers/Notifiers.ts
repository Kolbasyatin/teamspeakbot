import {log} from "../logger.js";
import type {ServerDescriptionView} from "../a2s/ServerMonitor.js";
import type {ServerSnapshot} from "../a2s/ServerProbe.js";
import {type ChannelDescriptionEditor, TSNotifier} from "./TSNotifier.js";
import {tgProperties, tsNotifierChannelNames} from "../properties.js";
import {notifierConfig} from "../notifierConfig.js";
import {LogNotifier} from "./LogNotifier.js";
import {Bot} from "grammy";
import {TelegramSender} from "../tg/TelegramSender.js";
import {TelegramOnlineHandler} from "../tg/TelegramOnlineHandler.js";
import {TelegramOfflineHandler} from "../tg/TelegramOfflineHandler.js";


export type NotificationEvent =
    | { type: "statusViewChanged"; view: ServerDescriptionView[] }
    | { type: "serverOnline"; snapshot: ServerSnapshot }
    | { type: "serverOffline"; snapshot: ServerSnapshot };

type NotificationEventType = NotificationEvent["type"];

export interface NotificationHandler {
    notify(event: NotificationEvent): Promise<void>;

    isActive(): boolean;

    close(): Promise<void>;
}

export class Notifier {
    private readonly handlersByEvent: Map<NotificationEventType, NotificationHandler[]>;

    constructor(channelEditor: ChannelDescriptionEditor) {
        const tsNotifier = new TSNotifier(channelEditor, notifierConfig.teamspeak, tsNotifierChannelNames.channels);
        const logNotifier = new LogNotifier(notifierConfig.log);
        const telegramBot = new Bot(tgProperties.token);
        const telegramSender = new TelegramSender(telegramBot, tgProperties.channelId)
        const telegramOnlineHandler = new TelegramOnlineHandler(telegramSender, notifierConfig.telegram);
        const telegramOfflineHandler = new TelegramOfflineHandler(telegramSender, notifierConfig.telegram)

        this.handlersByEvent = new Map<NotificationEventType, NotificationHandler[]>([
            ["statusViewChanged", [
                tsNotifier,
                logNotifier,
            ]],
            ["serverOnline", [
                telegramOnlineHandler,
            ]],
            ["serverOffline", [
                telegramOfflineHandler,
            ]],
        ]);
    }


    public async notify(event: NotificationEvent): Promise<void> {
        const handlers = this.handlersByEvent.get(event.type) ?? [];

        await Promise.allSettled(
            handlers
                .filter(handler => handler.isActive())
                .map(handler => handler.notify(event))
        );
    }

    public async close(): Promise<void> {
        const uniqueHandlers = new Set<NotificationHandler>();

        for (const handlers of this.handlersByEvent.values()) {
            for (const handler of handlers) {
                uniqueHandlers.add(handler);
            }
        }

        const results = await Promise.allSettled(
            [...uniqueHandlers].map(handler => handler.close())
        );

        results.forEach((result, index) => {
            if (result.status === "rejected") {
                log.warn(
                    {error: result.reason, handlerIndex: index},
                    "Notification handler close failed"
                );
            }
        });
    }
}
