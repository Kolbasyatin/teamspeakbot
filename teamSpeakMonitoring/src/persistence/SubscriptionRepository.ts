import {type Pool} from "mariadb";
import type {TelegramChat, TelegramChatType} from "../telegram/TelegramChat.js";
import {
    DEFAULT_SUBSCRIPTION_EVENTS,
    isSubscriptionEventKind,
    type SubscriptionEventKind,
} from "../telegram/SubscriptionEvent.js";

type ChatRow = {
    chatId: number | bigint;
    type: TelegramChatType;
    title: string | null;
};

type ServerIdRow = {
    serverId: number | bigint;
};

type ChatIdRow = {
    chatId: number | bigint;
};

type EventKindRow = {
    eventKind: string;
};

//Чтение и запись подписок — и ничего сверх того. Здесь нет ни решения «кого опрашивать»,
//ни «кому и что отправлять»: это доменные правила, они живут у своих потребителей.
//Граница та же, что у ServerRepository: отбор (WHERE) — язык запроса и остаётся тут,
//вывод чего-либо из прочитанного — нет. Поэтому логгера у репозитория нет: он ничего не решает.
//
//Обе стороны связи читаются отдельными методами, потому что вопросы разные и задают их разные люди:
//«на что подписан этот чат» спрашивает бот, отвечая человеку; «кто подписан на этот сервер» —
//рассылка, решая, куда отправить событие.
export class SubscriptionRepository {
    public constructor(private readonly pool: Pool) {
    }

    //Upsert, а не insert: бот видит чат при каждом сообщении и не обязан помнить, регистрировал ли
    //он его раньше. Заодно подхватывается переименование группы — название приезжает с апдейтом,
    //и другого момента узнать о нём нет.
    public async saveChat(chat: TelegramChat): Promise<void> {
        await this.pool.query(
            `
                INSERT INTO telegram_chats (chat_id, type, title)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE type  = VALUES(type),
                                        title = VALUES(title)
            `,
            [chat.chatId, chat.type, chat.title ?? null],
        );
    }

    public async findChat(chatId: number): Promise<TelegramChat | undefined> {
        const rows = await this.pool.query<ChatRow[]>(
            `
                SELECT chat_id AS chatId,
                       type,
                       title
                FROM telegram_chats
                WHERE chat_id = ?
            `,
            [chatId],
        );

        const row = rows[0];

        if (!row) {
            return undefined;
        }

        return {
            chatId: Number(row.chatId),
            type: row.type,
            //В домене отсутствие названия — undefined, в SQL — NULL. Перевод делается здесь,
            //чтобы NULL не протекал наружу вместе со строками.
            title: row.title ?? undefined,
        };
    }

    //Идемпотентна: повторное нажатие «подписаться» не ошибка и не вторая строка. Без этого
    //двойной тап по кнопке приводил бы к двум сообщениям на каждое падение сервера.
    //Ставка на UNIQUE (server_id, chat_id) из миграции 006, а не на предварительный SELECT:
    //проверка перед вставкой не атомарна, и два одновременных нажатия её обходят.
    //
    //Типы уведомлений по умолчанию проставляются ТОЛЬКО при создании подписки. INSERT IGNORE
    //отдаёт insertId = 0, когда строка уже была, и это здесь не формальность: иначе повторный
    //вызов вернул бы человеку галочки, которые он сам снял.
    public async subscribe(chatId: number, serverId: number): Promise<void> {
        const inserted = await this.pool.query(
            `
                INSERT IGNORE INTO server_subscriptions (server_id, chat_id)
                VALUES (?, ?)
            `,
            [serverId, chatId],
        );

        const subscriptionId = Number(inserted.insertId);

        if (subscriptionId === 0) {
            return;
        }

        for (const kind of DEFAULT_SUBSCRIPTION_EVENTS) {
            await this.pool.query(
                `
                    INSERT IGNORE INTO server_subscription_events (subscription_id, event_kind)
                    VALUES (?, ?)
                `,
                [subscriptionId, kind],
            );
        }
    }

    //Какие уведомления включены у этой подписки. Неизвестные значения отсеиваются: в колонке
    //строка, и после переименования типа там может остаться то, чего в коде уже нет.
    public async findSubscriptionEvents(
        chatId: number,
        serverId: number,
    ): Promise<SubscriptionEventKind[]> {
        const rows = await this.pool.query<EventKindRow[]>(
            `
                SELECT event.event_kind AS eventKind
                FROM server_subscription_events event
                         JOIN server_subscriptions subscription ON subscription.id = event.subscription_id
                WHERE subscription.chat_id = ?
                  AND subscription.server_id = ?
            `,
            [chatId, serverId],
        );

        return rows.map(row => row.eventKind).filter(isSubscriptionEventKind);
    }

    public async enableEvent(chatId: number, serverId: number, kind: SubscriptionEventKind): Promise<void> {
        await this.pool.query(
            `
                INSERT IGNORE INTO server_subscription_events (subscription_id, event_kind)
                SELECT id, ?
                FROM server_subscriptions
                WHERE chat_id = ?
                  AND server_id = ?
            `,
            [kind, chatId, serverId],
        );
    }

    public async disableEvent(chatId: number, serverId: number, kind: SubscriptionEventKind): Promise<void> {
        await this.pool.query(
            `
                DELETE event
                FROM server_subscription_events event
                         JOIN server_subscriptions subscription ON subscription.id = event.subscription_id
                WHERE subscription.chat_id = ?
                  AND subscription.server_id = ?
                  AND event.event_kind = ?
            `,
            [chatId, serverId, kind],
        );
    }

    //Отсутствие подписки не ошибка: «отписаться от того, на что не подписан» — это уже нужное
    //состояние, а не сбой. Поэтому возвращать количество удалённых строк нечему.
    public async unsubscribe(chatId: number, serverId: number): Promise<void> {
        await this.pool.query(
            `
                DELETE
                FROM server_subscriptions
                WHERE chat_id = ?
                  AND server_id = ?
            `,
            [chatId, serverId],
        );
    }

    //«На что подписан этот чат». Только идентификаторы: сами серверы читает ServerRepository,
    //и склеивать две выдачи в один запрос значило бы дублировать здесь его отбор.
    public async findSubscribedServerIds(chatId: number): Promise<number[]> {
        const rows = await this.pool.query<ServerIdRow[]>(
            `
                SELECT server_id AS serverId
                FROM server_subscriptions
                WHERE chat_id = ?
                ORDER BY server_id
            `,
            [chatId],
        );

        return rows.map(row => Number(row.serverId));
    }

    //«Кто подписан на этот сервер ВОТ НА ЭТОТ тип уведомления» — обратная сторона той же связи,
    //нужна рассылке. Тип обязателен: без него рассылка о конце раунда уходила бы и тем,
    //кто просил только про падения.
    public async findSubscriberChatIds(
        serverId: number,
        kind: SubscriptionEventKind,
    ): Promise<number[]> {
        const rows = await this.pool.query<ChatIdRow[]>(
            `
                SELECT subscription.chat_id AS chatId
                FROM server_subscriptions subscription
                         JOIN server_subscription_events event
                              ON event.subscription_id = subscription.id AND event.event_kind = ?
                WHERE subscription.server_id = ?
                ORDER BY subscription.chat_id
            `,
            [kind, serverId],
        );

        return rows.map(row => Number(row.chatId));
    }
}
