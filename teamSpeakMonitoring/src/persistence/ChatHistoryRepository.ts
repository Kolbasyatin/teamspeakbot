import {type Pool} from "mariadb";
import type {ChatHistorySource} from "../telegram/ChatListCommands.js";
import type {ChatHistoryEntry} from "../telegram/ChatHistoryMessage.js";
import type {CommandEntry, CommandJournalStore} from "../telegram/CommandJournal.js";

type CountRow = {
    total: number | bigint;
};

type HistoryRow = {
    at: Date;
    kind: "command" | "button" | "grant" | "revoke" | "feedback" | "reply";
    name: string | null;
    body: string | null;
    flag: number | bigint;
    userId: number | bigint | null;
    refId: number | bigint | null;
    extra: string | null;
};

//Журнал команд и история чата для /chats <chat_id> (итерация 23). Пишет только журнал команд —
//история прав пишется вместе с самими правами (RoleRepository), обратная связь — FeedbackRepository.
//Читает все четыре источника одной лентой.
export class ChatHistoryRepository implements CommandJournalStore, ChatHistorySource {
    public constructor(private readonly pool: Pool) {
    }

    public async saveCommand(entry: CommandEntry): Promise<void> {
        await this.pool.query(
            `
                INSERT INTO telegram_command_log (chat_id, user_id, kind, name, arguments, permission, allowed)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [entry.chatId, entry.userId ?? null, entry.kind, entry.name, entry.arguments ?? null, entry.permission ?? null, entry.allowed],
        );
    }

    public async countHistory(chatId: number): Promise<number> {
        const rows = await this.pool.query<CountRow[]>(
            `
                SELECT (SELECT COUNT(*) FROM telegram_command_log WHERE chat_id = ?)
                     + (SELECT COUNT(*) FROM role_events WHERE chat_id = ?)
                     + (SELECT COUNT(*) FROM feedback_messages WHERE chat_id = ?)
                     + (SELECT COUNT(*)
                        FROM feedback_replies reply
                                 JOIN feedback_messages feedback ON feedback.id = reply.feedback_id
                        WHERE feedback.chat_id = ?) AS total
            `,
            [chatId, chatId, chatId, chatId],
        );

        return Number(rows[0]?.total ?? 0);
    }

    //Четыре источника — UNION ALL с общим набором колонок, сортировка и предел — по ленте целиком.
    //Тексты обратной связи урезаются уже здесь: целиком они в /feedback, в ленте нужно начало.
    //Каждая часть идёт по индексу (chat_id, created_at) своей таблицы.
    public async findHistoryPage(chatId: number, limit: number, offset: number): Promise<ChatHistoryEntry[]> {
        const rows = await this.pool.query<HistoryRow[]>(
            `
                SELECT history.*
                FROM (SELECT log.created_at AS at,
                             log.kind       AS kind,
                             log.name       AS name,
                             log.arguments  AS body,
                             log.allowed    AS flag,
                             log.user_id    AS userId,
                             NULL           AS refId,
                             log.permission AS extra
                      FROM telegram_command_log log
                      WHERE log.chat_id = ?
                      UNION ALL
                      SELECT event.created_at, event.action, event.role, NULL, 1, event.actor_user_id, NULL, event.note
                      FROM role_events event
                      WHERE event.chat_id = ?
                      UNION ALL
                      SELECT feedback.created_at, 'feedback', NULL, LEFT(feedback.text, 300), 1, feedback.user_id, feedback.id, NULL
                      FROM feedback_messages feedback
                      WHERE feedback.chat_id = ?
                      UNION ALL
                      SELECT reply.created_at, 'reply', NULL, LEFT(reply.text, 300), reply.delivered, reply.admin_user_id,
                             reply.feedback_id, NULL
                      FROM feedback_replies reply
                               JOIN feedback_messages feedback ON feedback.id = reply.feedback_id
                      WHERE feedback.chat_id = ?) history
                ORDER BY history.at DESC
                LIMIT ? OFFSET ?
            `,
            [chatId, chatId, chatId, chatId, limit, offset],
        );

        return rows.map(toEntry);
    }
}

function toEntry(row: HistoryRow): ChatHistoryEntry {
    const at = row.at;
    const userId = row.userId === null ? undefined : Number(row.userId);

    switch (row.kind) {
        case "command":
        case "button":
            return {
                kind: row.kind,
                at,
                userId,
                name: row.name ?? "",
                arguments: row.body ?? undefined,
                known: row.extra !== null,
                allowed: Number(row.flag) === 1,
            };
        case "grant":
        case "revoke":
            return {kind: row.kind, at, role: row.name ?? "", actorUserId: userId, note: row.extra ?? undefined};
        case "feedback":
            return {kind: "feedback", at, feedbackId: Number(row.refId), text: row.body ?? "", userId};
        case "reply":
            return {kind: "reply", at, feedbackId: Number(row.refId), text: row.body ?? "", delivered: Number(row.flag) === 1};
    }
}
