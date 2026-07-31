import type {NotificationEvent} from "./events.js";
import type {ServerDescriptionView} from "../monitoring/ServerMonitor.js";
import type {ServerSnapshot, ServerStatus} from "../monitoring/ServerProbe.js";

//Источник текущего состояния. Интерфейс узкий и объявлен у потребителя — как ChannelDescriptionEditor
//у TeamSpeak-нотифаера: про монитор, probe'ы и опрос здесь знать нечего.
export interface CurrentStateSource {
    getView(): ServerDescriptionView[];

    getSnapshot(): ServerSnapshot[];
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
//Зачем: и TeamSpeak, и Telegram узнают о состоянии только в момент ИЗМЕНЕНИЯ. Если именно эта
//доставка упала, повторить её некому — ServerMonitor следующего события не пришлёт, пока состояние
//не изменится снова. Ровно этот случай воспроизведён тестом в итерации 5b: все серверы легли,
//channelEdit упал, и в описании канала навсегда остаётся устаревшее «online 12/64».
//
//Вид публикуем отдельным типом события (statusViewRefreshed), а не statusViewChanged: ничего
//не изменилось, и подписчик-журнал (LogNotifier) не должен писать вид целиком каждую минуту.
//Статусы серверов публикуем **обычными** serverOnline/serverOffline: для них отдельный тип не нужен,
//потому что решение «отправлять или молчать» принимает обёртка ChangesOnlyNotifier, сравнивая
//с последним успешно доставленным. Табло переписывается всегда, журнал — только при расхождении.
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

        for (const snapshot of this.state.getSnapshot()) {
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
