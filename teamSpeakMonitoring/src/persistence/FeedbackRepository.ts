import {type Pool} from "mariadb";
import type {FeedbackStore, NewFeedback, NewFeedbackReply, StoredFeedback} from "../telegram/FeedbackCommands.js";
import type {FeedbackReplyView, FeedbackThread} from "../telegram/FeedbackMessages.js";

type CountRow = {
    total: number | bigint;
};

type ThreadRow = {
    id: number | bigint;
    chatId: number | bigint;
    author: string | null;
    text: string;
    createdAt: Date;
};

type ReplyRow = {
    feedbackId: number | bigint;
    text: string;
    createdAt: Date;
    delivered: number;
    adminUserId: number | bigint | null;
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

    public async addReply(reply: NewFeedbackReply): Promise<void> {
        await this.pool.query(
            `
                INSERT INTO feedback_replies (feedback_id, admin_chat_id, admin_user_id, text, delivered)
                VALUES (?, ?, ?, ?, ?)
            `,
            [reply.feedbackId, reply.adminChatId, reply.adminUserId ?? null, reply.text, reply.delivered],
        );
    }

    public async countFeedback(): Promise<number> {
        const rows = await this.pool.query<CountRow[]>("SELECT COUNT(*) AS total FROM feedback_messages");

        return Number(rows[0]?.total ?? 0);
    }

    //Двумя запросами, а не JOIN: страница режется по обращениям, а ответов у каждого сколько угодно —
    //LIMIT по строкам JOIN разрезал бы переписку посередине.
    public async findFeedbackPage(limit: number, offset: number): Promise<FeedbackThread[]> {
        const threads = await this.pool.query<ThreadRow[]>(
            `
                SELECT id,
                       chat_id    AS chatId,
                       author,
                       text,
                       created_at AS createdAt
                FROM feedback_messages
                ORDER BY created_at DESC, id DESC
                LIMIT ? OFFSET ?
            `,
            [limit, offset],
        );

        if (threads.length === 0) {
            return [];
        }

        const replies = await this.pool.query<ReplyRow[]>(
            `
                SELECT feedback_id   AS feedbackId,
                       text,
                       created_at    AS createdAt,
                       delivered,
                       admin_user_id AS adminUserId
                FROM feedback_replies
                WHERE feedback_id IN (?)
                ORDER BY created_at, id
            `,
            [threads.map(thread => thread.id)],
        );
        const byFeedback = new Map<number, FeedbackReplyView[]>();

        for (const reply of replies) {
            const id = Number(reply.feedbackId);
            byFeedback.set(id, [...byFeedback.get(id) ?? [], {
                text: reply.text,
                createdAt: reply.createdAt,
                delivered: Boolean(reply.delivered),
                adminUserId: reply.adminUserId === null ? undefined : Number(reply.adminUserId),
            }]);
        }

        return threads.map(thread => ({
            id: Number(thread.id),
            chatId: Number(thread.chatId),
            author: thread.author ?? undefined,
            text: thread.text,
            createdAt: thread.createdAt,
            replies: byFeedback.get(Number(thread.id)) ?? [],
        }));
    }
}
