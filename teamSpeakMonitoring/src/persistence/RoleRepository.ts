import {type Pool} from "mariadb";
import type {RoleAssignment, RoleStore, StoredGrantResult} from "../access/AccessControl.js";
import type {Role} from "../access/Roles.js";

type RoleRow = {
    role: string;
};

type AssignmentRow = {
    chatId: number | bigint;
    role: string;
    grantedBy: number | bigint | null;
    grantedAt: Date;
    note: string | null;
    title: string | null;
};

type ExistsRow = {
    found: number | bigint;
};

//Чтение и запись назначений ролей — и ничего сверх того. Что роль разрешает и кто вправе её
//выдать, решает AccessControl; здесь даже не проверяется, что строка роли известна коду.
export class RoleRepository implements RoleStore {
    public constructor(private readonly pool: Pool) {
    }

    public async findRoles(chatId: number): Promise<string[]> {
        const rows = await this.pool.query<RoleRow[]>(
            `
                SELECT role
                FROM telegram_chat_roles
                WHERE chat_id = ?
                ORDER BY role
            `,
            [chatId],
        );

        return rows.map(row => row.role);
    }

    public async findAssignments(): Promise<RoleAssignment[]> {
        return this.queryAssignments("", []);
    }

    public async findAssignmentsByChat(chatId: number): Promise<RoleAssignment[]> {
        return this.queryAssignments("WHERE role.chat_id = ?", [chatId]);
    }

    //Отбор подставляется готовой строкой из двух методов выше, а не приходит снаружи:
    //значения идут только параметрами.
    private async queryAssignments(where: string, parameters: unknown[]): Promise<RoleAssignment[]> {
        const rows = await this.pool.query<AssignmentRow[]>(
            `
                SELECT role.chat_id    AS chatId,
                       role.role,
                       role.granted_by AS grantedBy,
                       role.granted_at AS grantedAt,
                       role.note,
                       chat.title
                FROM telegram_chat_roles role
                         JOIN telegram_chats chat ON chat.chat_id = role.chat_id
                ${where}
                ORDER BY role.chat_id, role.role
            `,
            parameters,
        );

        return rows.map(row => ({
            chatId: Number(row.chatId),
            role: row.role,
            grantedBy: row.grantedBy === null ? undefined : Number(row.grantedBy),
            grantedAt: row.grantedAt,
            note: row.note ?? undefined,
            chatTitle: row.title ?? undefined,
        }));
    }

    //Выдать можно только чату, который боту уже писал: на него смотрит внешний ключ, а заводить
    //чат «вслепую» по присланному числу значило бы хранить строки, о которых мы ничего не знаем.
    //Проверка перед вставкой не атомарна, но здесь это неважно: чат не исчезает между запросами,
    //а повторная выдача ловится PRIMARY KEY.
    public async grant(
        chatId: number,
        role: Role,
        grantedBy: number | undefined,
        note: string | undefined,
    ): Promise<StoredGrantResult> {
        const exists = await this.pool.query<ExistsRow[]>(
            "SELECT COUNT(*) AS found FROM telegram_chats WHERE chat_id = ?",
            [chatId],
        );

        if (Number(exists[0]?.found ?? 0) === 0) {
            return "unknownChat";
        }

        const inserted = await this.pool.query(
            `
                INSERT IGNORE INTO telegram_chat_roles (chat_id, role, granted_by, note)
                VALUES (?, ?, ?, ?)
            `,
            [chatId, role, grantedBy ?? null, note ?? null],
        );

        return Number(inserted.affectedRows) === 1 ? "granted" : "alreadyGranted";
    }

    public async revoke(chatId: number, role: Role): Promise<boolean> {
        const deleted = await this.pool.query(
            "DELETE FROM telegram_chat_roles WHERE chat_id = ? AND role = ?",
            [chatId, role],
        );

        return Number(deleted.affectedRows) > 0;
    }

    //Пометка «выдавали» ставится первой и условным UPDATE: кто её поставил, тот и выдаёт.
    //Два одновременных /start поэтому не выдадут роль дважды, а отобранная роль не вернётся.
    //Пометка и назначение — два запроса без транзакции: упади второй, и чат останется
    //с пометкой, но без роли. Выход из этого — /grant от админа, а не повторный /start;
    //транзакция ради такого редкого случая не окупает отдельного соединения из пула.
    public async grantDefaultOnce(chatId: number, role: Role): Promise<boolean> {
        const marked = await this.pool.query(
            `
                UPDATE telegram_chats
                SET default_role_granted_at = current_timestamp()
                WHERE chat_id = ?
                  AND default_role_granted_at IS NULL
            `,
            [chatId],
        );

        if (Number(marked.affectedRows) === 0) {
            return false;
        }

        await this.pool.query(
            "INSERT IGNORE INTO telegram_chat_roles (chat_id, role) VALUES (?, ?)",
            [chatId, role],
        );

        return true;
    }
}
