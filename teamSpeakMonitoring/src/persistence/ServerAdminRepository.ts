import {type Pool} from "mariadb";
import type {ServerQueryRole} from "../monitoring/MonitoredServer.js";
import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";
import type {
    AdminServer,
    AdminServerSummary,
    AdminSource,
    NewSource,
    ServerAdminStore,
    ServerPatch,
    SourcePatch,
} from "../servers/ServerAdminModel.js";
import {parseQueryConfig} from "./parseQueryConfig.js";
import {SERVER_LIST_ORDER} from "./serverListOrder.js";

type AdminServerRow = {
    id: number | bigint;
    name: string;
    gameAddress: string;
    enabled: number | boolean;
    listPosition: number | null;
    subscriberCount: number | bigint;
};

type SummaryRow = {
    id: number | bigint;
    name: string;
    gameAddress: string;
    enabled: number | boolean;
    listPosition: number | null;
    enabledSourceCount: number | bigint;
    enabledPrimaryCount: number | bigint;
};

type AdminSourceRow = {
    id: number | bigint;
    serverId: number | bigint;
    role: ServerQueryRole;
    priority: number;
    enabled: number | boolean;
    queryType: ServerQueryConfig["type"];
    queryConfig: string | ServerQueryConfig;
};

type CountRow = {
    total: number | bigint;
};

//Те же таблицы, что у ServerRepository, но другие вопросы: опросу нужны только включённые
//и только пригодные строки, администратору — все, вместе с причиной, почему строка непригодна.
//Поэтому отдельный класс, а не методы в читающем: правка админки не должна задевать запросы опроса.
//
//Правил здесь нет — ни «черновик», ни «один primary». Их держит servers/ServerAdmin.
export class ServerAdminRepository implements ServerAdminStore {
    public constructor(private readonly pool: Pool) {
    }

    public async findServer(id: number): Promise<AdminServer | undefined> {
        const [server] = await this.pool.query<AdminServerRow[]>(
            `
                SELECT server.id,
                       server.name,
                       server.game_address AS gameAddress,
                       server.enabled,
                       server.list_position AS listPosition,
                       (SELECT COUNT(*)
                        FROM server_subscriptions subscription
                        WHERE subscription.server_id = server.id) AS subscriberCount
                FROM monitored_servers server
                WHERE server.id = ?
            `,
            [id],
        );

        if (!server) {
            return undefined;
        }

        const sources = await this.pool.query<AdminSourceRow[]>(
            `${SOURCE_SELECT} WHERE server_id = ? ORDER BY priority, id`,
            [id],
        );

        return {
            id: Number(server.id),
            name: server.name,
            gameAddress: server.gameAddress,
            enabled: Boolean(server.enabled),
            listPosition: server.listPosition ?? undefined,
            subscriberCount: Number(server.subscriberCount),
            sources: sources.map(toAdminSource),
        };
    }

    public async findSource(id: number): Promise<AdminSource | undefined> {
        const [row] = await this.pool.query<AdminSourceRow[]>(`${SOURCE_SELECT} WHERE id = ?`, [id]);

        return row ? toAdminSource(row) : undefined;
    }

    //Все серверы, включая выключенные и черновики. Порядок тот же, что в каталоге (SERVER_LIST_ORDER):
    //администратор видит закреплённые там же, где их увидят все.
    public async findSummaryPage(search: string, limit: number, offset: number): Promise<AdminServerSummary[]> {
        const rows = await this.pool.query<SummaryRow[]>(
            `
                SELECT server.id,
                       server.name,
                       server.game_address AS gameAddress,
                       server.enabled,
                       server.list_position AS listPosition,
                       (SELECT COUNT(*)
                        FROM server_query_sources source
                        WHERE source.server_id = server.id
                          AND source.enabled = TRUE) AS enabledSourceCount,
                       (SELECT COUNT(*)
                        FROM server_query_sources source
                        WHERE source.server_id = server.id
                          AND source.enabled = TRUE
                          AND source.role = 'primary') AS enabledPrimaryCount
                FROM monitored_servers server
                WHERE (? = '' OR server.name LIKE CONCAT('%', ?, '%'))
                ORDER BY ${SERVER_LIST_ORDER}
                LIMIT ? OFFSET ?
            `,
            [search, search, limit, offset],
        );

        return rows.map(row => ({
            id: Number(row.id),
            name: row.name,
            gameAddress: row.gameAddress,
            enabled: Boolean(row.enabled),
            listPosition: row.listPosition ?? undefined,
            enabledSourceCount: Number(row.enabledSourceCount),
            enabledPrimaryCount: Number(row.enabledPrimaryCount),
        }));
    }

    public async countSummaries(search: string): Promise<number> {
        const rows = await this.pool.query<CountRow[]>(
            `
                SELECT COUNT(*) AS total
                FROM monitored_servers
                WHERE (? = '' OR name LIKE CONCAT('%', ?, '%'))
            `,
            [search, search],
        );

        return Number(rows[0]?.total ?? 0);
    }

    public async createServer(name: string, gameAddress: string): Promise<number> {
        const inserted = await this.pool.query(
            "INSERT INTO monitored_servers (name, game_address, enabled) VALUES (?, ?, FALSE)",
            [name, gameAddress],
        );

        return Number(inserted.insertId);
    }

    public async updateServer(id: number, patch: ServerPatch): Promise<void> {
        await this.update("monitored_servers", id, {
            name: patch.name,
            game_address: patch.gameAddress,
            enabled: patch.enabled,
            //null — снять позицию: в колонку уходит NULL, а undefined означает «не трогать».
            list_position: patch.listPosition,
        });
    }

    //Источники и подписки уходят каскадом (миграции 002 и 006). Подтверждение — забота того,
    //кто вызывает: удаление необратимо.
    public async deleteServer(id: number): Promise<void> {
        await this.pool.query("DELETE FROM monitored_servers WHERE id = ?", [id]);
    }

    //query_type пишется из того же конфига, что и query_config: расхождение двух колонок
    //parseQueryConfig при чтении считает порчей, и создать его отсюда нельзя.
    public async createSource(serverId: number, source: NewSource): Promise<number> {
        const inserted = await this.pool.query(
            `
                INSERT INTO server_query_sources (server_id, role, priority, query_type, query_config, enabled)
                VALUES (?, ?, ?, ?, ?, ?)
            `,
            [serverId, source.role, source.priority, source.config.type, JSON.stringify(source.config), source.enabled],
        );

        return Number(inserted.insertId);
    }

    public async updateSource(id: number, patch: SourcePatch): Promise<void> {
        await this.update("server_query_sources", id, {
            role: patch.role,
            priority: patch.priority,
            enabled: patch.enabled,
            query_type: patch.config?.type,
            query_config: patch.config === undefined ? undefined : JSON.stringify(patch.config),
        });
    }

    public async deleteSource(id: number): Promise<void> {
        await this.pool.query("DELETE FROM server_query_sources WHERE id = ?", [id]);
    }

    //UPDATE только тех колонок, что заданы. Имена колонок — из кода этого класса, не снаружи:
    //в запрос подставляются только они, значения идут параметрами.
    private async update(table: "monitored_servers" | "server_query_sources", id: number, columns: Record<string, unknown>): Promise<void> {
        const assigned = Object.entries(columns).filter(([, value]) => value !== undefined);

        if (assigned.length === 0) {
            return;
        }

        await this.pool.query(
            `UPDATE ${table} SET ${assigned.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
            [...assigned.map(([, value]) => value), id],
        );
    }
}

const SOURCE_SELECT = `
    SELECT id,
           server_id    AS serverId,
           role,
           priority,
           enabled,
           query_type   AS queryType,
           query_config AS queryConfig
    FROM server_query_sources
`;

//Непригодный конфиг здесь не ошибка, а то, что администратор должен увидеть, — с причиной.
//Разбор тот же, что у опроса (parseQueryConfig), чтобы «пригоден» значило одно и то же.
function toAdminSource(row: AdminSourceRow): AdminSource {
    const base = {
        id: Number(row.id),
        serverId: Number(row.serverId),
        role: row.role,
        priority: Number(row.priority),
        enabled: Boolean(row.enabled),
        queryType: row.queryType,
        raw: rawOf(row.queryConfig),
    };

    try {
        return {...base, config: parseQueryConfig(row), problem: undefined};
    } catch (error) {
        return {...base, config: undefined, problem: error instanceof Error ? error.message : String(error)};
    }
}

function rawOf(value: string | ServerQueryConfig): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;

        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
    } catch {
        return undefined;
    }
}
