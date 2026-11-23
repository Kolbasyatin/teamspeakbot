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
        const rows = await this.pool.query<ChatRow[]>(
            `
                SELECT chat.chat_id                                        AS chatId,
                       chat.type,
                       chat.title,
                       chat.created_at                                     AS createdAt,
                       GROUP_CONCAT(role.role ORDER BY role.role SEPARATOR ',') AS roles,
                       (SELECT COUNT(*)
                        FROM server_subscriptions subscription
                        WHERE subscription.chat_id = chat.chat_id)         AS subscriptions
                FROM telegram_chats chat
                         LEFT JOIN telegram_chat_roles role ON role.chat_id = chat.chat_id
                GROUP BY chat.chat_id, chat.type, chat.title, chat.created_at
                ORDER BY chat.created_at DESC, chat.chat_id DESC
                LIMIT ? OFFSET ?
            `,
            [limit, offset],
        );

        return rows.map(row => ({
            chatId: Number(row.chatId),
            type: row.type,
            title: row.title ?? undefined,
            firstSeenAt: row.createdAt,
            roles: row.roles === null ? [] : row.roles.split(","),
            serverSubscriptions: Number(row.subscriptions),
        }));
    }
}
