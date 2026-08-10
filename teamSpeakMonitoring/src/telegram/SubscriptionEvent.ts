//Что именно подписчик хочет получать про сервер. Подписка одна — «слежу за этим сервером», —
//а типов внутри неё несколько, и каждый включается отдельно.
//
//Имена уезжают в БД как строки, поэтому переименование любого из них — миграция.
//`status` отвергнут как слишком общий, `isAlive` — из-за приставки `is`, которая обычно означает
//булево поле, а не значение перечисления. `roundFinish`, а не `roundEnd`: нам важно именно
//ШТАТНОЕ завершение, и «finish» это передаёт.
export type SubscriptionEventKind = "availability" | "roundFinish";

//Единственное место, где типы перечислены как ЗНАЧЕНИЕ, а не как тип: в рантайме тип не существует,
//а строку из БД сверять с чем-то надо. Record, а не массив: добавили значение в объединение —
//сборка падает, пока его не внесли сюда.
//Заодно это подписи для галочек в боте: второго списка, который может разъехаться, не появляется.
export const SUBSCRIPTION_EVENT_TITLES: Record<SubscriptionEventKind, string> = {
    availability: "падения и подъёмы",
    roundFinish: "конец раунда",
};

//Что включается при подписке на сервер. Оба типа: человек подписывается, чтобы знать,
//а не чтобы потом искать настройки.
export const DEFAULT_SUBSCRIPTION_EVENTS: readonly SubscriptionEventKind[] = [
    "availability",
    "roundFinish",
];

export function isSubscriptionEventKind(value: string): value is SubscriptionEventKind {
    return value in SUBSCRIPTION_EVENT_TITLES;
}
