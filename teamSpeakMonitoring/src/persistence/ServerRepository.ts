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
//у которого источников не осталось, ни знания о том, КТО подписан: это доменные правила,
//они живут в buildMonitorConfigs и в доставке.
//Граница проходит так: отбор (WHERE) — язык запроса и остаётся тут; вывод чего-либо из прочитанного —
//нет. Поэтому логгера у репозитория тоже нет: предупреждать не о чем, он ничего не решает.
//Замена MariaDB на SQLite = другая реализация этого класса, отдающая тот же StoredServer[].
export class ServerRepository {
    public constructor(private readonly pool: Pool) {
    }

    //Серверы, которые кому-то нужны: включённые И имеющие хотя бы одну подписку.
    //
    //Два условия, а не одно, потому что вопросы разные. enabled — «можно ли на него подписаться»,
    //то есть видимость в каталоге; подписка — «нужен ли он кому-то прямо сейчас». Каталог из тысячи
    //серверов при трёх подписках даёт три опроса, а не тысячу.
    //
    //EXISTS, а не JOIN: сервер с десятью подписчиками должен приехать одной строкой, а не десятью.
    //Кто именно подписан, здесь не спрашивается вовсе — это вопрос доставки, и отвечает на него
    //SubscriptionRepository.
    //
    //Два запроса, а не JOIN с источниками: при джойне поля сервера дублируются на каждый источник,
    //а сервер без единого включённого источника из выдачи исчезает — притом что отдать его наружу
    //нужно, иначе о нём некому будет предупредить.
    public async findMonitored(): Promise<StoredServer[]> {
        const servers = await this.pool.query<ServerRow[]>(
            `
                SELECT server.id,
                       server.name,
                       server.game_address AS gameAddress
                FROM monitored_servers server
                WHERE server.enabled = ?
                  AND EXISTS (SELECT 1
                              FROM server_subscriptions subscription
                              WHERE subscription.server_id = server.id)
                ORDER BY server.id
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
    //
    //Условия отбора повторяют findMonitored слово в слово, и это не лишнее: источники читаются
    //отдельным запросом, поэтому без них сюда приедут источники серверов, которых в выдаче нет.
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
                  AND EXISTS (SELECT 1
                              FROM server_subscriptions subscription
                              WHERE subscription.server_id = server.id)
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
