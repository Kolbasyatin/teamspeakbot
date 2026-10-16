import {type Pool} from "mariadb";
import type {FeedbackStore, NewFeedback, StoredFeedback} from "../telegram/FeedbackCommands.js";

type CountRow = {
    total: number | bigint;
};

type FeedbackRow = {
    id: number | bigint;
    chatId: number | bigint;
    text: string;
};

//Хранение обратной связи (миграция 011) — и ничего сверх того. Сколько сообщений разрешено
//и кому доставлять, решает FeedbackCommands.
export class FeedbackRepository implements FeedbackStore {
    public constructor(private readonly pool: Pool) {
    }

    public async save(feedback: NewFeedback): Promise<number> {
        const inserted = await this.pool.query(
            "INSERT INTO feedback_messages (chat_id, user_id, author, text) VALUES (?, ?, ?, ?)",
            [feedback.chatId, feedback.userId ?? null, feedback.author, feedback.text],
        );

        return Number(inserted.insertId);
    }

    //Окно считается по часам базы, а не приложения: created_at ставит MariaDB, и сравнивать его
    //с Date из Node значило бы зависеть от совпадения часовых поясов сессии и процесса.
    public async countRecent(chatId: number, windowSeconds: number): Promise<number> {
        const rows = await this.pool.query<CountRow[]>(
            `
                SELECT COUNT(*) AS total
                FROM feedback_messages
                WHERE chat_id = ?
                  AND created_at > NOW() - INTERVAL ? SECOND
            `,
            [chatId, windowSeconds],
        );

        return Number(rows[0]?.total ?? 0);
    }

    public async addDelivery(feedbackId: number, adminChatId: number, adminMessageId: number): Promise<void> {
        await this.pool.query(
            "INSERT IGNORE INTO feedback_deliveries (feedback_id, admin_chat_id, admin_message_id) VALUES (?, ?, ?)",
            [feedbackId, adminChatId, adminMessageId],
        );
    }

    public async findByDelivery(adminChatId: number, adminMessageId: number): Promise<StoredFeedback | undefined> {
        const [row] = await this.pool.query<FeedbackRow[]>(
            `
                SELECT feedback.id,
                       feedback.chat_id AS chatId,
                       feedback.text
                FROM feedback_deliveries delivery
                         JOIN feedback_messages feedback ON feedback.id = delivery.feedback_id
                WHERE delivery.admin_chat_id = ?
                  AND delivery.admin_message_id = ?
            `,
            [adminChatId, adminMessageId],
        );

        return row ? {id: Number(row.id), chatId: Number(row.chatId), text: row.text} : undefined;
    }
}
