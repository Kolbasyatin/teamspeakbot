import type {NotificationEvent} from "./events.js";
import type {ServerProbeSnapshot, ServerStatus} from "../monitoring/ServerProbe.js";

//Источник текущего состояния. Интерфейс узкий и объявлен у потребителя — как ChannelDescriptionEditor
//у TeamSpeak-нотифаера: про монитор, probe'ы и опрос здесь знать нечего.
export interface CurrentStateSource {
    getSnapshot(): ServerProbeSnapshot[];
}

//Какое событие переопубликовывать для каждого статуса. Record, а не switch: добавится четвёртый
//статус — сборка упадёт, пока для него не решат, что публиковать.
//unknown (ответа от сервера ещё не было) — не публикуем: сказать про такой сервер нечего,
//уведомление «статус неизвестен» не нужно. Решение zalex от 2026-07-31.
const STATUS_EVENT: Record<ServerStatus, "serverOnline" | "serverOffline" | undefined> = {
    online: "serverOnline",
    offline: "serverOffline",
    unknown: undefined,
};

//Куда публикуем. Ровно сигнатура NotificationDispatcher.notify, но без зависимости от него.
export interface StatePublisher {
    notify(event: NotificationEvent): Promise<void>;
}

//Периодическая публикация текущего состояния.
//
//Зачем: доставка каждого потребителя отфильтрована его собственной дедупликацией — молчим, пока
//состояние совпадает с последним успешно доставленным. Если доставка упала, повторить её некому:
//поток событий продолжается, но по нему потребитель промолчит, как только состояние вернётся
//к прежнему. Этот тик — единственное, что публикуется В ОБХОД дедупликации, поэтому им чинится
//и упавшая доставка, и правка описания канала, сделанная в TeamSpeak руками.
//
//Состояние публикуем отдельным типом (serverStateRepublished), а не serverStateUpdated: тип и есть
//тот признак, по которому потребитель отличает «можно промолчать» от «перезаписать безусловно».
//Статусы серверов публикуем **обычными** serverOnline/serverOffline: для них отдельный тип не нужен,
//потому что там дедупликация желательна — Telegram это журнал, и повторять «is online» каждую
//минуту незачем. ChangesOnlyNotifier пропустит их только при расхождении с доставленным.
//
//Часов внутри нет: когда публиковать — решает Scheduler в composition root.
export class StateSync {

    constructor(
        private readonly state: CurrentStateSource,
        private readonly publisher: StatePublisher,
    ) {
    }

    public async publishCurrentState(): Promise<void> {
        //Одно чтение на весь тик: табло и статусы серверов обязаны говорить об одном и том же
        //состоянии, а между двумя обращениями к источнику успевает пройти опрос.
        const snapshots = this.state.getSnapshot();

        await this.publisher.notify({type: "serverStateRepublished", snapshots});

        for (const snapshot of snapshots) {
            const type = STATUS_EVENT[snapshot.status];

            if (!type) {
                continue;
            }

            //Диспетчер не бросает: отказы каналов он логирует сам. Поэтому один проблемный сервер
            //не мешает переопубликовать остальные.
            await this.publisher.notify({type, snapshot});
        }
    }
}
