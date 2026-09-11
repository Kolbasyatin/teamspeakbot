import type {Logger} from "pino";
import type {ScheduledTask} from "../monitoring/Scheduler.js";
import {PlayerObserverUnavailable, type PlayerEvent, type PlayerObserver} from "./PlayerObserver.js";

//Хранилище курсора и подписок глазами ленты: три вопроса, а не весь репозиторий.
//Интерфейс объявлен здесь, у потребителя, как ServerCatalog в SubscriptionCommands.
export interface PlayerEventStore {
    findCursor(): Promise<number | undefined>;

    saveCursor(lastEventId: number): Promise<void>;

    findAllSubscribedPlayerIds(): Promise<number[]>;

    findSubscribedChatIds(playerId: number): Promise<number[]>;
}

//Куда уходит событие после того, как найдены адресаты. Отдельно от поллера намеренно: он про
//«что случилось и кому это интересно», доставка — не его дело.
export interface PlayerEventSink {
    deliver(chatId: number, event: PlayerEvent): Promise<void>;
}

export interface PlayerEventPollerProperties {
    intervalMs: number;
    //Размер страницы. Ограничивает всплеск: при массовом заходе на сервер за тик приедет не больше
    //этого числа событий, остальные — следующим тиком.
    pageSize: number;
}

//Лента событий наблюдателя: спрашиваем новое, рассылаем подписчикам, двигаем курсор.
//
//КУРСОР ДВИГАЕТСЯ ТОЛЬКО ПОСЛЕ УСПЕШНОЙ ДОСТАВКИ, и это главное свойство этого класса.
//Сохрани мы его раньше — падение процесса или отказ Telegram между «прочитали» и «отправили»
//терял бы события молча, а человек так и не узнал бы, что за ним заходил тот, на кого он подписан.
//Обратная сторона — возможный повтор сообщения при падении посреди страницы: дубликат лучше потери.
//
//Работает даже при нуле подписок: курсор всё равно должен доехать до конца ленты, иначе первая же
//подписка получила бы историю за всё время простоя.
export class PlayerEventPoller implements ScheduledTask {
    public readonly id = "playerEvents";

    //Курсор известен — читаем с него. Неизвестен (первый запуск, пустая таблица) — начинаем
    //с текущей головы ленты: рассылать вход, случившийся до установки бота, бессмысленно.
    private cursor: number | undefined;

    public constructor(
        private readonly observer: PlayerObserver,
        private readonly store: PlayerEventStore,
        private readonly sink: PlayerEventSink,
        private readonly properties: PlayerEventPollerProperties,
        private readonly logger: Logger,
    ) {
    }

    public getNextDelayMs(): number {
        return this.properties.intervalMs;
    }

    public async run(): Promise<void> {
        try {
            await this.poll();
        } catch (error) {
            //Недоступность соседа — ожидаемое состояние, а не поломка: курсор не двинулся,
            //те же события приедут на следующем тике. Поэтому warn, а не error.
            if (error instanceof PlayerObserverUnavailable) {
                this.logger.warn({error: error.message}, "Лента событий игроков недоступна");
                return;
            }

            throw error;
        }
    }

    private async poll(): Promise<void> {
        const cursor = await this.resolveCursor();
        const playerIds = await this.store.findAllSubscribedPlayerIds();
        const page = await this.observer.events(cursor, playerIds, this.properties.pageSize);

        for (const event of page.events) {
            await this.deliver(event);
        }

        if (page.nextAfter !== cursor) {
            await this.store.saveCursor(page.nextAfter);
            this.cursor = page.nextAfter;
        }

        if (page.events.length > 0) {
            this.logger.info(
                {events: page.events.length, cursor: page.nextAfter, players: playerIds.length},
                "Разосланы события игроков",
            );
        }
    }

    //Отказ доставки одному чату не должен останавливать страницу: остальные подписчики
    //ни при чём. Ошибка логируется, курсор всё равно уедет вперёд — повторять доставку
    //этого события некуда, лента не хранит «кому не дошло».
    private async deliver(event: PlayerEvent): Promise<void> {
        const chatIds = await this.store.findSubscribedChatIds(event.playerId);

        for (const chatId of chatIds) {
            try {
                await this.sink.deliver(chatId, event);
            } catch (error) {
                this.logger.error({error, chatId, eventId: event.id}, "Не удалось доставить событие игрока");
            }
        }
    }

    private async resolveCursor(): Promise<number> {
        if (this.cursor !== undefined) {
            return this.cursor;
        }

        const stored = await this.store.findCursor();

        if (stored !== undefined) {
            this.cursor = stored;
            return stored;
        }

        //Первый запуск: начинаем с текущей головы и сразу её запоминаем, иначе при отказе
        //на первой же странице голова успеет уехать и часть событий прочитается зря.
        const head = await this.observer.eventsHead();

        await this.store.saveCursor(head);
        this.cursor = head;
        this.logger.info({cursor: head}, "Курсор ленты событий игроков установлен на текущий конец");

        return head;
    }
}
