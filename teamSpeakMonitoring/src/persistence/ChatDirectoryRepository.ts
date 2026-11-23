import {type Pool} from "mariadb";
import type {ChatDirectory} from "../telegram/ChatListCommands.js";
import type {ChatCounts, ChatListEntry} from "../telegram/ChatListMessage.js";
import type {TelegramChatType} from "../telegram/TelegramChat.js";

type CountRow = {
    total: number | bigint;
    privateChats: number | bigint | null;
};

type ChatRow = {
    chatId: number | bigint;
    type: TelegramChatType;
    title: string | null;
    createdAt: Date;
    roles: string | null;
    subscriptions: number | bigint;
    lists: string | null;
    blockedAt: Date | null;
};

//Список чатов для /chats: кто писал боту, роли и число подписок на серверы. Только чтение.
//Отдельно от SubscriptionRepository и RoleRepository: тем нужна строка одного чата, а здесь —
//сводка по всем, и на два чужих репозитория она бы размазалась.
export class ChatDirectoryRepository implements ChatDirectory {
    public constructor(private readonly pool: Pool) {
    }

    public async countChats(): Promise<ChatCounts> {
        const rows = await this.pool.query<CountRow[]>(
            `
                SELECT COUNT(*)                   AS total,
                       SUM(type = 'private')      AS privateChats
                FROM telegram_chats
            `,
        );
        const row = rows[0];

        return {
            total: Number(row?.total ?? 0),
            //SUM по пустой таблице — NULL, а не ноль.
            private: Number(row?.privateChats ?? 0),
        };
    }

    //Новые сверху; chat_id — второй ключ, чтобы порядок был однозначным при одинаковом времени
    //(миграция 009 вставила много чатов одним моментом) и листание не теряло и не повторяло строки.
    //Роли — GROUP_CONCAT по LEFT JOIN, подписки — подзапросом: JOIN по подпискам размножил бы роли.
    public async findChatPage(limit: number, offset: number): Promise<ChatListEntry[]> {
        return this.queryChats("", "LIMIT ? OFFSET ?", [limit, offset]);
    }

    public async findChat(chatId: number): Promise<ChatListEntry | undefined> {
        const [chat] = await this.queryChats("WHERE chat.chat_id = ?", "", [chatId]);

        return chat;
    }

    //Отбор и предел подставляются готовыми строками из двух методов выше, значения — только параметрами.
    private async queryChats(where: string, limit: string, parameters: unknown[]): Promise<ChatListEntry[]> {
        const rows = await this.pool.query<ChatRow[]>(
            `
                SELECT chat.chat_id                                        AS chatId,
                       chat.type,
                       chat.title,
                       chat.created_at                                     AS createdAt,
                       GROUP_CONCAT(role.role ORDER BY role.role SEPARATOR ',') AS roles,
                       (SELECT COUNT(*)
                        FROM server_subscriptions subscription
                        WHERE subscription.chat_id = chat.chat_id)         AS subscriptions,
                       (SELECT GROUP_CONCAT(list.name ORDER BY list.name SEPARATOR ',')
                        FROM mailing_list_members member
                                 JOIN mailing_lists list ON list.id = member.list_id
                        WHERE member.chat_id = chat.chat_id)               AS lists,
                       chat.blocked_at                                     AS blockedAt
                FROM telegram_chats chat
                         LEFT JOIN telegram_chat_roles role ON role.chat_id = chat.chat_id
                ${where}
                GROUP BY chat.chat_id, chat.type, chat.title, chat.created_at, chat.blocked_at
                ORDER BY chat.created_at DESC, chat.chat_id DESC
                ${limit}
            `,
            parameters,
        );

        return rows.map(row => ({
            chatId: Number(row.chatId),
            type: row.type,
            title: row.title ?? undefined,
            firstSeenAt: row.createdAt,
            roles: row.roles === null ? [] : row.roles.split(","),
            serverSubscriptions: Number(row.subscriptions),
            lists: row.lists === null ? [] : row.lists.split(","),
            blocked: row.blockedAt !== null,
        }));
    }
}
