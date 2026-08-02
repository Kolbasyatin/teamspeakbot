import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";

//Контракт уведомлений: что происходит и кто это умеет доставлять.
//Лежит отдельно от диспетчера, чтобы каждая реализация зависела от контракта,
//а не от файла своего потребителя.

//serverStateUpdated и serverStateRepublished несут одни и те же данные, но разный факт:
//первое — «серверы опрошены» (приходит после каждого опроса, без фильтрации), второе —
//«состояние публикуется принудительно» (периодическая синхронизация).
//
//Разница не в данных, а в том, можно ли по этому событию промолчать. Первое проходит через
//дедупликацию потребителя: их много за минуту, и писать по каждому некуда. Второе идёт мимо неё,
//поэтому им чинится то, о чём мы узнать не можем, — описание канала, поправленное в TeamSpeak
//руками. Совпадает с нашим состоянием оно или нет, тик всё равно перезапишет.
//
//Обоим событиям достаются сырые снапшоты, а не готовый вид: что из них показать — дело
//потребителя, и у описания канала, журнала и будущего HTTP-эндпоинта ответы разные.
export type NotificationEvent =
    | { type: "serverStateUpdated"; snapshots: ServerProbeSnapshot[] }
    | { type: "serverStateRepublished"; snapshots: ServerProbeSnapshot[] }
    | { type: "serverOnline"; snapshot: ServerProbeSnapshot }
    | { type: "serverOffline"; snapshot: ServerProbeSnapshot };

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
