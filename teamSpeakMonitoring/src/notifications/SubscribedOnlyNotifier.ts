import type {Notifier, NotificationEventOf} from "./events.js";

//События, несущие состояние всех серверов сразу. Те же два, что обслуживает TeamSpeakChannelNotifier.
export type StateEventType = "serverStateUpdated" | "serverStateRepublished";

//Обёртка, оставляющая в событии только снапшоты нужных серверов.
//
//Зачем. Монитор опрашивает всё, на что подписан хоть кто-то, и в событие приезжают снапшоты
//чужих серверов тоже. Табло в TeamSpeak должно показывать не это, а список СВОЕГО чата —
//того, что задан в TELEGRAM_CHANNEL_ID (telegram.md, §5.3).
//
//Почему обёртка, а не условие внутри TeamSpeakChannelNotifier: фильтрация — правило доставки,
//а работа канала — «отрендерить и записать». Разделение то же, что у ChangesOnlyNotifier
//и LatestOnlyNotifier, и по той же причине: какой канал каким правилом обёрнут, видно в main.ts.
//
//ВАЖНО, ГДЕ ОНА СТОИТ: строго СНАРУЖИ ChangesOnlyNotifier. Ключ дедупликации табло — это
//отрендеренный текст описания, то есть он считается по snapshots. Поставь фильтр глубже —
//в ключ попадут серверы, которых на табло нет, и любое изменение на чужом сервере будет считаться
//изменением табло: описание в TeamSpeak начнёт переписываться по чужому поводу.
//
//Пустой набор — это пустое табло, а не пропуск доставки. Молчать нельзя: если у чата не осталось
//подписок, описание обязано опустеть, а не замереть на последнем состоянии.
export class SubscribedOnlyNotifier implements Notifier<StateEventType> {
    constructor(
        private readonly inner: Notifier<StateEventType>,
        //Функция, а не набор: он меняется при пересборке списка опроса, и обёртка обязана
        //видеть свежий. Владеет им composition root — там же, где решают, когда его перечитывать.
        private readonly serverIds: () => ReadonlySet<number>,
    ) {
    }

    public async notify(event: NotificationEventOf<StateEventType>): Promise<void> {
        const showListServerIds = this.serverIds();

        await this.inner.notify({
            ...event,
            snapshots: event.snapshots.filter(snapshot => showListServerIds.has(snapshot.config.id)),
        });
    }
}
