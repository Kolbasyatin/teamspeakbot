import type {Notifier, NotificationEventOf, NotificationEventType} from "./events.js";

//Обёртка над нотифаером: доставляет событие только если по этому предмету ещё не доставлено
//такое же состояние. Помнит **последнюю успешную** доставку — упавшая не запоминается и повторится.
//
//Зачем: канал Telegram — это журнал, а не табло. Периодическая синхронизация состояния присылает
//статус каждого сервера каждую минуту, и без этой обёртки в канал ушло бы 1440 сообщений
//«is online» в сутки. С ней тик молчит, пока состояние совпадает с доставленным, и оживает ровно
//в двух случаях: состояние действительно изменилось, либо прошлая отправка не удалась.
//
//Что считать «предметом» и «состоянием» — задаётся при сборке: для статусов серверов это
//«сервер» и «его статус». Поэтому падение одного сервера не глушит сообщение про другой.
//
//Память живёт в процессе: после рестарта первый тик отправит статусы заново. Это не регресс —
//сейчас то же самое делает переход unknown → online на первом опросе (долг, п. 14).
export class ChangesOnlyNotifier<TType extends NotificationEventType> implements Notifier<TType> {
    private readonly delivered = new Map<string, string>();

    constructor(
        private readonly inner: Notifier<TType>,
        private readonly subjectOf: (event: NotificationEventOf<TType>) => string,
        private readonly stateOf: (event: NotificationEventOf<TType>) => string,
    ) {
    }

    public async notify(event: NotificationEventOf<TType>): Promise<void> {
        const subject = this.subjectOf(event);
        const state = this.stateOf(event);

        if (this.delivered.get(subject) === state) {
            return;
        }

        //Запоминаем ДО отправки, а при отказе откатываем. Иначе два одновременных вызова с одним
        //состоянием (тик и реальный переход статуса приходят независимо, через void) оба прошли бы
        //проверку до того, как первый успел записаться, — и в канал ушло бы два одинаковых сообщения.
        this.delivered.set(subject, state);

        try {
            await this.inner.notify(event);
        } catch (error) {
            //Откатываем только своё: если за время отправки по этому же предмету доставили другое
            //состояние, затирать его нельзя.
            if (this.delivered.get(subject) === state) {
                this.delivered.delete(subject);
            }

            throw error;
        }
    }
}
