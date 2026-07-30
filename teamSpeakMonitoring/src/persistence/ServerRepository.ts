import type {ServerMonitorConfig} from "../monitoring/MonitoredServer.js";
import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";
import {type Pool} from "mariadb";


type ServerRow = {
    id: number;
    name: string;
    gameAddress: string;
    queryType: ServerQueryConfig["type"];
    queryConfig: string | ServerQueryConfig;
};

export class ServerRepository {
    public constructor(private readonly pool: Pool) {
    }

    public async findAllEnabled(): Promise<ServerMonitorConfig[]> {
        const rows = await this.pool.query<ServerRow[]>(
            `
                SELECT id,
                       name,
                       game_address AS gameAddress,
                       query_type   AS queryType,
                       query_config AS queryConfig
                FROM monitored_servers
                WHERE enabled = ?
                ORDER BY id
            `,
            [true],
        );

        return rows.map(row => ({
            id: Number(row.id),
            name: row.name,
            gameAddress: row.gameAddress,
            query: this.parseQueryConfig(row),
        }));
    }

    private parseQueryConfig(row: ServerRow): ServerQueryConfig {
        const queryConfig: unknown = typeof row.queryConfig === "string"
            ? JSON.parse(row.queryConfig)
            : row.queryConfig;

        if (!queryConfig || typeof queryConfig !== "object") {
            throw new Error(`Invalid query_config for server ${row.id}`);
        }

        const query = queryConfig as Partial<ServerQueryConfig>;

        if (query.type !== row.queryType) {
            throw new Error(`query_type mismatch for server ${row.id}`);
        }

        return query as ServerQueryConfig;
    }
}
