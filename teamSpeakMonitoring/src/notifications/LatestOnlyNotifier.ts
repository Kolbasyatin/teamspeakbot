import type {Notifier, NotificationEventOf, NotificationEventType} from "./events.js";
import type {Logger} from "pino";

//Обёртка над нотифаером: пока доставка идёт, новые события перезаписывают друг друга,
//и по завершении доставляется только самое свежее. Промежуточные выбрасываются.
//В литературе это называется coalescing.
//
//Зачем: описание канала TeamSpeak — это табло текущего состояния, а не журнал событий.
//ServerMonitor эмитит stateUpdated после опроса КАЖДОГО сервера, безусловно, а доставка идёт
//через void — без ожидания. Без этой обёртки они уходят в channelEdit на единственное
//SSH-соединение и копятся там очередью, хотя первые устарели к моменту отправки.
//Дедупликация снаружи гасит совпадающие, но соседние тики с разными данными она пропускает —
//именно они и склеиваются здесь.
//
//Оборачивать имеет смысл только тех, для кого важно последнее состояние. Telegram оборачивать
//нельзя: там каждое событие — самостоятельный факт, который нельзя потерять.
export class LatestOnlyNotifier<TType extends NotificationEventType> implements Notifier<TType> {
    private pending: NotificationEventOf<TType> | undefined;
    private delivering = false;

    constructor(
        private readonly inner: Notifier<TType>,
        private readonly logger: Logger,
    ) {
    }

    public async notify(event: NotificationEventOf<TType>): Promise<void> {
        //Записываем ДО проверки delivering: иначе события, пришед шие во время доставки,
        //потерялись бы полностью, а не схлопнулись в последнее.
        this.pending = event;

        if (this.delivering) {
            //Доставка уже идёт — её цикл сам подхватит то, что мы только что положили.
            return;
        }

        this.delivering = true;

        try {
            while (this.pending !== undefined) {
                const next = this.pending;
                //Снимаем до await: всё, что придёт за время доставки, попадёт в следующий виток.
                this.pending = undefined;
                await this.inner.notify(next);
            }
        } catch (error) {
            //Доставка упала, и цикла больше нет. Если за это время пришло новое состояние,
            //забрать его некому: следующий stateUpdated придёт, но дедупликация снаружи его
            //проглотит — она уже записала это состояние как доставленное.
            //Починка снаружи: StateSync раз в MONITOR_STATE_SYNC_INTERVAL_MS публикует текущее
            //состояние независимо от изменений, и потерянное доезжает следующим тиком (итерация 8a).
            //Предупреждение остаётся: потеря реальна, а опоздание на минуту стоит видеть в логе.
            if (this.pending !== undefined) {
                this.pending = undefined;
                this.logger.warn(
                    {error},
                    "Pending notification dropped after delivery failure",
                );
            }

            throw error;
        } finally {
            //Между последней проверкой while и этой строкой нет ни одного await, поэтому
            //в успешном пути «pending установлен, а доставлять некому» возникнуть не может:
            //JS однопоточен, вклиниться туда нечему.
            this.delivering = false;
        }
    }
}
