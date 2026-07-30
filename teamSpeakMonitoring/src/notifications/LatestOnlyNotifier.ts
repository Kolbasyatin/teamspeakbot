import type {Notifier, NotificationEventOf, NotificationEventType} from "./events.js";
import type {Logger} from "pino";

//Обёртка над нотифаером: пока доставка идёт, новые события перезаписывают друг друга,
//и по завершении доставляется только самое свежее. Промежуточные выбрасываются.
//В литературе это называется coalescing.
//
//Зачем: описание канала TeamSpeak — это табло текущего состояния, а не журнал событий.
//emitChangedIfNeeded() срабатывает после опроса каждого сервера, поэтому за один цикл может
//прийти несколько viewChanged, а вызываются они через void — без ожидания. Без этой обёртки
//все они уходят в channelEdit на единственное SSH-соединение и копятся там очередью,
//хотя первые уже устарели к моменту отправки.
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
        //Записываем ДО проверки delivering: иначе события, пришедшие во время доставки,
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
            //забрать его некому до следующего события — а следующего может и не быть:
            //ServerMonitor эмитит viewChanged только при ИЗМЕНЕНИИ состояния. Значит описание
            //канала останется устаревшим до первого реального изменения.
            //Дырка известна и записана в долг (AGENTS.md, п. 24); лечится периодическим
            //подтверждением состояния. Пока делаем потерю хотя бы видимой.
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
