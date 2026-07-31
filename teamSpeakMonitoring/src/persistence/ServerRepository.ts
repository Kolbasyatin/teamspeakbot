import type {ServerMonitorConfig} from "../monitoring/MonitoredServer.js";
import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";
import {type Pool} from "mariadb";
import {parseQueryConfig} from "./parseQueryConfig.js";


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
            query: parseQueryConfig(row),
        }));
    }
}
