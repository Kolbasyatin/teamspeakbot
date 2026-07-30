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

//Событие одного конкретного типа: NotificationEventOf<"serverOnline"> — это вариант со snapshot.
export type NotificationEventOf<TType extends NotificationEventType> =
    Extract<NotificationEvent, { type: TType }>;

//Канал доставки. Параметризован типом события, поэтому notify получает уже суженный тип
//и проверять event.type внутри не нужно.
//Ресурсами (соединения, боты) владеет composition root, поэтому close() здесь нет.
export interface Notifier<TType extends NotificationEventType> {
    notify(event: NotificationEventOf<TType>): Promise<void>;
}

//Подписка со стёртым типом события: диспетчеру нужен однородный список, а типы у нотифаеров разные.
export interface NotificationSubscription {
    event: NotificationEventType;
    //Имя канала доставки — нужно только логам, никакой логики на него не завязано и не парсится.
    //До его появления отказ логировался как handlerIndex: 2, то есть индексом в массиве.
    //Тип события в имени не дублируем: он и так пишется в лог отдельным полем.
    name: string;
    notify(event: NotificationEvent): Promise<void>;
}

//Единственное место в проекте, где тип события приводится. Приведение безопасно по построению:
//диспетчер вызывает notify только для события того типа, который указан в этой же подписке.
//Взамен несовпадение типа события и нотифаера становится ошибкой компиляции:
//subscribe("serverOnline", "log", new LogNotifier(log)) не соберётся.
export function subscribe<TType extends NotificationEventType>(
    event: TType,
    name: string,
    notifier: Notifier<TType>,
): NotificationSubscription {
    return {
        event,
        name,
        notify: (received: NotificationEvent): Promise<void> =>
            notifier.notify(received as NotificationEventOf<TType>),
    };
}
