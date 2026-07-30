import type {ServerDescriptionView} from "../monitoring/ServerMonitor.js";
import type {ServerSnapshot} from "../monitoring/ServerProbe.js";

//Контракт уведомлений: что происходит и кто это умеет доставлять.
//Лежит отдельно от диспетчера, чтобы каждая реализация зависела от контракта,
//а не от файла своего потребителя.

export type NotificationEvent =
    | { type: "statusViewChanged"; view: ServerDescriptionView[] }
    | { type: "serverOnline"; snapshot: ServerSnapshot }
    | { type: "serverOffline"; snapshot: ServerSnapshot };

export type NotificationEventType = NotificationEvent["type"];

//Канал доставки. Ресурсами (соединения, боты) владеет composition root, поэтому close() здесь нет.
export interface Notifier {
    notify(event: NotificationEvent): Promise<void>;
}

//Что на какое событие подписано. Список собирается в main.ts: там видно всю систему целиком.
//name нужен только логам — без него непонятно, какой именно канал отказал.
export interface NotificationSubscription {
    event: NotificationEventType;
    name: string;
    notifier: Notifier;
}
