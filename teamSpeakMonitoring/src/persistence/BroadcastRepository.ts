import {type Pool} from "mariadb";
import {
    describeTarget,
    targetFromDescription,
    type BroadcastContent,
    type BroadcastStatus,
    type BroadcastStore,
    type BroadcastTarget,
    type DeliveryCounts,
    type DeliveryOutcome,
    type ListMember,
    type ListsOverview,
    type MailingListStore,
    type MembershipChange,
    type NewBroadcast,
    type StoredBroadcast,
} from "../broadcasts/Broadcasts.js";

type IdRow = {id: number | bigint};
type ChatIdRow = {chatId: number | bigint};
type CountRow = {total: number | bigint};

type BroadcastRow = {
    id: number | bigint;
    authorUserId: number | bigint;
    authorChatId: number | bigint;
    sourceChatId: number | bigint | null;
    sourceMessageId: number | bigint | null;
    text: string | null;
    preview: string | null;
    target: string;
    status: BroadcastStatus;
    recipients: number;
    delivered: number;
    blocked: number;
    failed: number;
    createdAt: Date;
    finishedAt: Date | null;
};

type SummaryRow = {name: string; description: string | null; members: number | bigint};
type OverviewRow = {total: number | bigint; unsorted: number | bigint; blocked: number | bigint};
type MemberRow = {chatId: number | bigint; title: string | null; type: string; blockedAt: Date | null};

//Рассылки и списки рассылки (итерация 24, миграция 014). Только хранение и отбор адресатов;
//правила — в broadcasts/, Telegram — в адаптерах.
export class BroadcastRepository implements BroadcastStore, MailingListStore {
    public constructor(private readonly pool: Pool) {
    }

    public async createBroadcast(broadcast: NewBroadcast): Promise<number> {
        const content = broadcast.content;
        const inserted = await this.pool.query(
            `
                INSERT INTO broadcasts (author_user_id, author_chat_id, source_chat_id, source_message_id, text,
                                        preview, target, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
            `,
            [
                broadcast.authorUserId,
                broadcast.authorChatId,
                content.kind === "copy" ? content.fromChatId : null,
                content.kind === "copy" ? content.messageId : null,
                content.kind === "text" ? content.text : null,
                broadcast.preview?.slice(0, 255) ?? null,
                describeTarget(broadcast.target),
            ],
        );

        return Number(inserted.insertId);
    }

    public async findBroadcast(id: number): Promise<StoredBroadcast | undefined> {
        const [row] = await this.queryBroadcasts("WHERE id = ?", "", [id]);

        return row;
    }

    public async findRecentBroadcasts(limit: number): Promise<StoredBroadcast[]> {
        return this.queryBroadcasts("WHERE status <> 'pending'", "LIMIT ?", [limit]);
    }

    public async startBroadcast(id: number): Promise<boolean> {
        return this.transition(id, "sending");
    }

    public async cancelBroadcast(id: number): Promise<boolean> {
        return this.transition(id, "cancelled");
    }

    //Встроенные адресаты вычисляются здесь же, из telegram_chats: хранить «всех» отдельно значило бы
    //держать копию того, что уже лежит в таблице чатов.
    public async resolveRecipients(target: BroadcastTarget): Promise<number[]> {
        const query = recipientsQuery(target);
        const rows = await this.pool.query<ChatIdRow[]>(query.sql, query.parameters);

        return rows.map(row => Number(row.chatId));
    }

    //Итог и пометка «заблокировал» одним запросом каждый; транзакция не нужна: пометка — следствие
    //итога, а не наоборот, и разъезд между ними исправит следующая рассылка или первая же команда чата.
    public async recordDelivery(broadcastId: number, chatId: number, outcome: DeliveryOutcome): Promise<void> {
        await this.pool.query(
            `
                INSERT INTO broadcast_deliveries (broadcast_id, chat_id, status, error)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE status       = VALUES(status),
                                        error        = VALUES(error),
                                        delivered_at = current_timestamp()
            `,
            [broadcastId, chatId, outcome.status, outcome.status === "delivered" ? null : outcome.error],
        );

        if (outcome.status === "blocked") {
            await this.pool.query(
                "UPDATE telegram_chats SET blocked_at = COALESCE(blocked_at, current_timestamp()) WHERE chat_id = ?",
                [chatId],
            );
        } else if (outcome.status === "delivered") {
            await this.pool.query("UPDATE telegram_chats SET blocked_at = NULL WHERE chat_id = ?", [chatId]);
        }
    }

    public async finishBroadcast(id: number, counts: DeliveryCounts): Promise<void> {
        await this.pool.query(
            `
                UPDATE broadcasts
                SET status      = 'done',
                    recipients  = ?,
                    delivered   = ?,
                    blocked     = ?,
                    failed      = ?,
                    finished_at = current_timestamp()
                WHERE id = ?
            `,
            [counts.recipients, counts.delivered, counts.blocked, counts.failed, id],
        );
    }

    public async interruptUnfinished(): Promise<number> {
        const updated = await this.pool.query(
            "UPDATE broadcasts SET status = 'interrupted', finished_at = current_timestamp() WHERE status = 'sending'",
        );

        return Number(updated.affectedRows);
    }

    public async createList(name: string, description: string | undefined, createdBy: number): Promise<"created" | "exists"> {
        const inserted = await this.pool.query(
            "INSERT IGNORE INTO mailing_lists (name, description, created_by) VALUES (?, ?, ?)",
            [name, description ?? null, createdBy],
        );

        return Number(inserted.affectedRows) === 1 ? "created" : "exists";
    }

    public async deleteList(name: string): Promise<boolean> {
        const deleted = await this.pool.query("DELETE FROM mailing_lists WHERE name = ?", [name]);

        return Number(deleted.affectedRows) > 0;
    }

    //По чату на запрос: чатов в одной команде единицы, а так видно, кого добавили, кто уже был
    //и кого бот не знает.
    public async includeChats(name: string, chatIds: readonly number[], addedBy: number): Promise<MembershipChange | undefined> {
        const listId = await this.listIdOf(name);

        if (listId === undefined) {
            return undefined;
        }

        const change: MembershipChange = {changed: [], unchanged: [], unknown: []};

        for (const chatId of chatIds) {
            const inserted = await this.pool.query(
                `
                    INSERT IGNORE INTO mailing_list_members (list_id, chat_id, added_by)
                    SELECT ?, chat_id, ?
                    FROM telegram_chats
                    WHERE chat_id = ?
                `,
                [listId, addedBy, chatId],
            );

            if (Number(inserted.affectedRows) === 1) {
                change.changed.push(chatId);
            } else if (await this.chatExists(chatId)) {
                change.unchanged.push(chatId);
            } else {
                change.unknown.push(chatId);
            }
        }

        return change;
    }

    public async excludeChats(name: string, chatIds: readonly number[]): Promise<MembershipChange | undefined> {
        const listId = await this.listIdOf(name);

        if (listId === undefined) {
            return undefined;
        }

        const change: MembershipChange = {changed: [], unchanged: [], unknown: []};

        for (const chatId of chatIds) {
            const deleted = await this.pool.query(
                "DELETE FROM mailing_list_members WHERE list_id = ? AND chat_id = ?",
                [listId, chatId],
            );

            (Number(deleted.affectedRows) > 0 ? change.changed : change.unchanged).push(chatId);
        }

        return change;
    }

    public async listsOverview(): Promise<ListsOverview> {
        const lists = await this.pool.query<SummaryRow[]>(
            `
                SELECT list.name,
                       list.description,
                       (SELECT COUNT(*) FROM mailing_list_members member WHERE member.list_id = list.id) AS members
                FROM mailing_lists list
                ORDER BY list.name
            `,
        );
        const [overview] = await this.pool.query<OverviewRow[]>(
            `
                SELECT SUM(chat.blocked_at IS NULL)                                    AS total,
                       SUM(chat.blocked_at IS NULL AND NOT EXISTS (SELECT 1
                                                                   FROM mailing_list_members member
                                                                   WHERE member.chat_id = chat.chat_id)) AS unsorted,
                       SUM(chat.blocked_at IS NOT NULL)                                AS blocked
                FROM telegram_chats chat
            `,
        );

        return {
            lists: lists.map(list => ({name: list.name, description: list.description ?? undefined, members: Number(list.members)})),
            //SUM по пустой таблице — NULL.
            all: Number(overview?.total ?? 0),
            unsorted: Number(overview?.unsorted ?? 0),
            blocked: Number(overview?.blocked ?? 0),
        };
    }

    public async listMembers(name: string): Promise<ListMember[] | undefined> {
        const listId = await this.listIdOf(name);

        if (listId === undefined) {
            return undefined;
        }

        const rows = await this.pool.query<MemberRow[]>(
            `
                SELECT chat.chat_id    AS chatId,
                       chat.title,
                       chat.type,
                       chat.blocked_at AS blockedAt
                FROM mailing_list_members member
                         JOIN telegram_chats chat ON chat.chat_id = member.chat_id
                WHERE member.list_id = ?
                ORDER BY chat.title, chat.chat_id
            `,
            [listId],
        );

        return rows.map(row => ({
            chatId: Number(row.chatId),
            title: row.title ?? undefined,
            type: row.type,
            blocked: row.blockedAt !== null,
        }));
    }

    private async transition(id: number, status: "sending" | "cancelled"): Promise<boolean> {
        const updated = await this.pool.query(
            `UPDATE broadcasts SET status = ?${status === "cancelled" ? ", finished_at = current_timestamp()" : ""}
             WHERE id = ? AND status = 'pending'`,
            [status, id],
        );

        return Number(updated.affectedRows) === 1;
    }

    private async listIdOf(name: string): Promise<number | undefined> {
        const [row] = await this.pool.query<IdRow[]>("SELECT id FROM mailing_lists WHERE name = ?", [name]);

        return row ? Number(row.id) : undefined;
    }

    private async chatExists(chatId: number): Promise<boolean> {
        const [row] = await this.pool.query<CountRow[]>("SELECT COUNT(*) AS total FROM telegram_chats WHERE chat_id = ?", [chatId]);

        return Number(row?.total ?? 0) > 0;
    }

    private async queryBroadcasts(where: string, limit: string, parameters: unknown[]): Promise<StoredBroadcast[]> {
        const rows = await this.pool.query<BroadcastRow[]>(
            `
                SELECT id,
                       author_user_id    AS authorUserId,
                       author_chat_id    AS authorChatId,
                       source_chat_id    AS sourceChatId,
                       source_message_id AS sourceMessageId,
                       text,
                       preview,
                       target,
                       status,
                       recipients,
                       delivered,
                       blocked,
                       failed,
                       created_at        AS createdAt,
                       finished_at       AS finishedAt
                FROM broadcasts
                ${where}
                ORDER BY id DESC
                ${limit}
            `,
            parameters,
        );

        return rows.flatMap(toBroadcast);
    }
}

function recipientsQuery(target: BroadcastTarget): {sql: string; parameters: unknown[]} {
    switch (target.kind) {
        case "chat":
            return {sql: "SELECT chat_id AS chatId FROM telegram_chats WHERE chat_id = ?", parameters: [target.chatId]};
        case "all":
            return {sql: "SELECT chat_id AS chatId FROM telegram_chats WHERE blocked_at IS NULL ORDER BY chat_id", parameters: []};
        case "unsorted":
            return {
                sql: `
                    SELECT chat.chat_id AS chatId
                    FROM telegram_chats chat
                    WHERE chat.blocked_at IS NULL
                      AND NOT EXISTS (SELECT 1 FROM mailing_list_members member WHERE member.chat_id = chat.chat_id)
                    ORDER BY chat.chat_id
                `,
                parameters: [],
            };
        case "list":
            return {
                sql: `
                    SELECT chat.chat_id AS chatId
                    FROM mailing_lists list
                             JOIN mailing_list_members member ON member.list_id = list.id
                             JOIN telegram_chats chat ON chat.chat_id = member.chat_id
                    WHERE list.name = ?
                      AND chat.blocked_at IS NULL
                    ORDER BY chat.chat_id
                `,
                parameters: [target.name],
            };
    }
}

//Строка, которую нельзя разобрать (адресат в непонятном формате), в выдачу не попадает: показывать
//и запускать такую рассылку всё равно нельзя.
function toBroadcast(row: BroadcastRow): StoredBroadcast[] {
    const target = targetFromDescription(row.target);
    const content: BroadcastContent | undefined = row.sourceChatId !== null && row.sourceMessageId !== null
        ? {kind: "copy", fromChatId: Number(row.sourceChatId), messageId: Number(row.sourceMessageId)}
        : row.text !== null ? {kind: "text", text: row.text} : undefined;

    if (!target || !content) {
        return [];
    }

    return [{
        id: Number(row.id),
        authorUserId: Number(row.authorUserId),
        authorChatId: Number(row.authorChatId),
        content,
        preview: row.preview ?? undefined,
        target,
        status: row.status,
        recipients: Number(row.recipients),
        delivered: Number(row.delivered),
        blocked: Number(row.blocked),
        failed: Number(row.failed),
        createdAt: row.createdAt,
        finishedAt: row.finishedAt ?? undefined,
    }];
}
