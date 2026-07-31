import type {NotificationEvent} from "./events.js";
import type {ServerDescriptionView} from "../monitoring/ServerMonitor.js";

//Источник текущего состояния. Интерфейс узкий и объявлен у потребителя — как ChannelDescriptionEditor
//у TeamSpeak-нотифаера: про монитор, probe'ы и опрос здесь знать нечего.
export interface CurrentStateSource {
    getView(): ServerDescriptionView[];
}

//Куда публикуем. Ровно сигнатура NotificationDispatcher.notify, но без зависимости от него.
export interface StatePublisher {
    notify(event: NotificationEvent): Promise<void>;
}

//Периодическая публикация текущего состояния.
//
//Зачем: и TeamSpeak, и Telegram узнают о состоянии только в момент ИЗМЕНЕНИЯ. Если именно эта
//доставка упала, повторить её некому — ServerMonitor следующего события не пришлёт, пока состояние
//не изменится снова. Ровно этот случай воспроизведён тестом в итерации 5b: все серверы легли,
//channelEdit упал, и в описании канала навсегда остаётся устаревшее «online 12/64».
//
//Публикуем отдельным типом события (statusViewRefreshed), а не statusViewChanged: ничего
//не изменилось, и подписчик-журнал (LogNotifier) не должен писать вид целиком каждую минуту.
//
//Часов внутри нет: когда публиковать — решает Scheduler в composition root.
export class StateSync {

    constructor(
        private readonly state: CurrentStateSource,
        private readonly publisher: StatePublisher,
    ) {
    }

    public async publishCurrentState(): Promise<void> {
        await this.publisher.notify({
            type: "statusViewRefreshed",
            view: this.state.getView(),
        });
    }
}
