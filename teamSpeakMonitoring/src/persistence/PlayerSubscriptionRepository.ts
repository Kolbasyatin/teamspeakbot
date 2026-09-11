import {type Pool} from "mariadb";

type PlayerIdRow = {
    playerId: number | bigint;
};

type ChatIdRow = {
    chatId: number | bigint;
};

type CursorRow = {
    lastEventId: number | bigint;
};

type PendingRow = {
    chatId: number | bigint;
    nickname: string;
};

//Одна отложенная подписка: чат ждёт игрока с таким ником.
export interface PendingPlayerSubscription {
    chatId: number;
    nickname: string;
}

//Чтение и запись подписок на игроков — и ничего сверх того. Граница та же, что у
//SubscriptionRepository: отбор (WHERE) — язык запроса и остаётся тут, решения о том, кому и что
//отправлять, принимает потребитель.
//
//player_id — число чужого сервиса, внешнего ключа на него нет и быть не может: игроки живут
//в другой базе. Репозиторий этого не знает и знать не должен, для него это просто идентификатор.
export class PlayerSubscriptionRepository {
    public constructor(private readonly pool: Pool) {
    }

    //Идемпотентна, как и подписка на сервер: повторное нажатие — не ошибка и не вторая строка.
    //Ставка на UNIQUE (chat_id, player_id) из миграции 008, а не на предварительный SELECT:
    //проверка перед вставкой не атомарна.
    public async subscribe(chatId: number, playerId: number): Promise<void> {
        await this.pool.query(
            `
                INSERT IGNORE INTO player_subscriptions (chat_id, player_id)
                VALUES (?, ?)
            `,
            [chatId, playerId],
        );
    }

    public async unsubscribe(chatId: number, playerId: number): Promise<void> {
        await this.pool.query(
            `
                DELETE
                FROM player_subscriptions
                WHERE chat_id = ?
                  AND player_id = ?
            `,
            [chatId, playerId],
        );
    }

    public async findSubscribedPlayerIds(chatId: number): Promise<number[]> {
        const rows = await this.pool.query<PlayerIdRow[]>(
            `
                SELECT player_id AS playerId
                FROM player_subscriptions
                WHERE chat_id = ?
                ORDER BY created_at
            `,
            [chatId],
        );

        return rows.map(row => Number(row.playerId));
    }

    //Кто подписан на этого игрока. Спрашивает рассылка, разбирая событие.
    public async findSubscribedChatIds(playerId: number): Promise<number[]> {
        const rows = await this.pool.query<ChatIdRow[]>(
            `
                SELECT chat_id AS chatId
                FROM player_subscriptions
                WHERE player_id = ?
            `,
            [playerId],
        );

        return rows.map(row => Number(row.chatId));
    }

    //Все игроки, на которых подписан хоть кто-то. Этот список уезжает в запрос ленты фильтром:
    //без него пришлось бы тянуть события всех сорока тысяч игроков.
    public async findAllSubscribedPlayerIds(): Promise<number[]> {
        const rows = await this.pool.query<PlayerIdRow[]>(
            `
                SELECT DISTINCT player_id AS playerId
                FROM player_subscriptions
            `,
        );

        return rows.map(row => Number(row.playerId));
    }

    //Курсор ленты. Пустая таблица — курсора нет: приложение решит, откуда начинать,
    //и это не дело хранилища.
    public async findCursor(): Promise<number | undefined> {
        const rows = await this.pool.query<CursorRow[]>(
            `
                SELECT last_event_id AS lastEventId
                FROM player_event_cursor
                WHERE id = 1
            `,
        );

        const row = rows[0];

        return row ? Number(row.lastEventId) : undefined;
    }

    //GREATEST, а не присваивание: курсор двигается только вперёд. Иначе запоздавший ответ
    //от предыдущего тика отбросил бы его назад и события пришли бы повторно.
    public async saveCursor(lastEventId: number): Promise<void> {
        await this.pool.query(
            `
                INSERT INTO player_event_cursor (id, last_event_id)
                VALUES (1, ?)
                ON DUPLICATE KEY UPDATE last_event_id = GREATEST(player_event_cursor.last_event_id, VALUES(last_event_id))
            `,
            [lastEventId],
        );
    }

    //Отложенная подписка по нику. Повторный запрос того же ника продлевает срок, а не плодит строки.
    public async addPending(chatId: number, nickname: string, expiresAt: Date): Promise<void> {
        await this.pool.query(
            `
                INSERT INTO pending_player_subscriptions (chat_id, nickname, expires_at)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at)
            `,
            [chatId, nickname, expiresAt],
        );
    }

    public async removePending(chatId: number, nickname: string): Promise<void> {
        await this.pool.query(
            `
                DELETE
                FROM pending_player_subscriptions
                WHERE chat_id = ?
                  AND nickname = ?
            `,
            [chatId, nickname],
        );
    }

    public async findPendingByChat(chatId: number): Promise<string[]> {
        const rows = await this.pool.query<PendingRow[]>(
            `
                SELECT chat_id AS chatId, nickname
                FROM pending_player_subscriptions
                WHERE chat_id = ?
                ORDER BY created_at
            `,
            [chatId],
        );

        return rows.map(row => row.nickname);
    }

    //Живые ожидания всех чатов: их периодически перепроверяет резолвер.
    public async findActivePending(now: Date): Promise<PendingPlayerSubscription[]> {
        const rows = await this.pool.query<PendingRow[]>(
            `
                SELECT chat_id AS chatId, nickname
                FROM pending_player_subscriptions
                WHERE expires_at > ?
                ORDER BY created_at
            `,
            [now],
        );

        return rows.map(row => ({chatId: Number(row.chatId), nickname: row.nickname}));
    }

    //Просроченные удаляются молча: человеку сказали срок, когда он заводил ожидание.
    public async deleteExpiredPending(now: Date): Promise<number> {
        const result = await this.pool.query(
            `
                DELETE
                FROM pending_player_subscriptions
                WHERE expires_at <= ?
            `,
            [now],
        );

        return Number(result.affectedRows ?? 0);
    }

    public async countPendingByChat(chatId: number): Promise<number> {
        const rows = await this.pool.query<{total: number | bigint}[]>(
            `
                SELECT count(*) AS total
                FROM pending_player_subscriptions
                WHERE chat_id = ?
            `,
            [chatId],
        );

        const row = rows[0];

        return row ? Number(row.total) : 0;
    }
}
