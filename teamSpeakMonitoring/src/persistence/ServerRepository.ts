import type {
    ServerQueryRole,
    ServerQuerySource,
    StoredServer,
} from "../monitoring/MonitoredServer.js";
import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";
import {type Pool} from "mariadb";
import {parseQueryConfig} from "./parseQueryConfig.js";


type ServerRow = {
    id: number | bigint;
    name: string;
    gameAddress: string;
};

type SourceRow = {
    id: number | bigint;
    serverId: number | bigint;
    role: ServerQueryRole;
    priority: number;
    queryType: ServerQueryConfig["type"];
    queryConfig: string | ServerQueryConfig;
};

//Чтение и только чтение. Здесь нет ни выбора главного источника, ни решения выбросить сервер,
//у которого источников не осталось: это доменные правила, они живут в buildMonitorConfigs.
//Граница проходит так: отбор (WHERE) — язык запроса и остаётся тут; вывод чего-либо из прочитанного —
//нет. Поэтому логгера у репозитория тоже нет: предупреждать не о чем, он ничего не решает.
//Замена MariaDB на SQLite = другая реализация этого класса, отдающая тот же StoredServer[].
export class ServerRepository {
    public constructor(private readonly pool: Pool) {
    }

    //Два запроса, а не JOIN: при джойне поля сервера дублируются на каждый источник, а сервер
    //без единого включённого источника из выдачи исчезает — притом что отдать его наружу нужно,
    //иначе о нём некому будет предупредить.
    public async findAllEnabled(): Promise<StoredServer[]> {
        const servers = await this.pool.query<ServerRow[]>(
            `
                SELECT id,
                       name,
                       game_address AS gameAddress
                FROM monitored_servers
                WHERE enabled = ?
                ORDER BY id
            `,
            [true],
        );

        const sourcesByServer = await this.findEnabledSources();

        return servers.map(server => ({
            id: Number(server.id),
            name: server.name,
            gameAddress: server.gameAddress,
            sources: sourcesByServer.get(Number(server.id)) ?? [],
        }));
    }

    //Без ORDER BY по приоритету намеренно: порядок источников — это порядок слияния данных,
    //то есть доменное правило, и сортирует их buildMonitorConfigs. Будь порядок на совести
    //запроса, забытый ORDER BY в новой реализации молча менял бы то, чьи данные побеждают.
    private async findEnabledSources(): Promise<Map<number, ServerQuerySource[]>> {
        const rows = await this.pool.query<SourceRow[]>(
            `
                SELECT source.id,
                       source.server_id    AS serverId,
                       source.role,
                       source.priority,
                       source.query_type   AS queryType,
                       source.query_config AS queryConfig
                FROM server_query_sources source
                         JOIN monitored_servers server ON server.id = source.server_id
                WHERE source.enabled = ?
                  AND server.enabled = ?
            `,
            [true, true],
        );

        const byServer = new Map<number, ServerQuerySource[]>();

        for (const row of rows) {
            const serverId = Number(row.serverId);
            const sources = byServer.get(serverId) ?? [];

            sources.push({
                id: Number(row.id),
                role: row.role,
                priority: Number(row.priority),
                query: parseQueryConfig(row),
            });

            byServer.set(serverId, sources);
        }

        return byServer;
    }
}
