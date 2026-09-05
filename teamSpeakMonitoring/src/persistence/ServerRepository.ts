import type {
    ServerQueryRole,
    ServerQuerySource,
    StoredServer,
} from "../monitoring/MonitoredServer.js";
import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";
import type {CatalogServer} from "../catalog/CatalogServer.js";
import {type Pool} from "mariadb";
import {parseQueryConfig} from "./parseQueryConfig.js";


type ServerRow = {
    id: number | bigint;
    name: string;
    gameAddress: string;
};

type CountRow = {
    total: number | bigint;
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

    //Каталог: страница серверов, из которых человек выбирает, на что подписаться.
    //
    //Здесь ДРУГОЙ отбор, чем в findMonitored, и это не оплошность: в каталоге показываются все
    //включённые серверы, в том числе те, на которые никто пока не подписан, — иначе подписаться
    //было бы не на что. То самое разделение смыслов: enabled — про видимость, подписка — про опрос.
    //
    //Сортировка по имени, а не по id: человек ищет глазами по названию. id добивает ничью,
    //чтобы страницы не разъезжались при одинаковых именах.
    public async findCatalogPage(search: string, limit: number, offset: number): Promise<CatalogServer[]> {
        const rows = await this.pool.query<ServerRow[]>(
            `
                SELECT id,
                       name,
                       game_address AS gameAddress
                FROM monitored_servers
                WHERE enabled = ?
                  AND (? = '' OR name LIKE CONCAT('%', ?, '%'))
                ORDER BY name, id
                LIMIT ? OFFSET ?
            `,
            [true, search, search, limit, offset],
        );

        return rows.map(toCatalogServer);
    }

    //Сколько всего в каталоге по этому запросу. Нужен постранично: без общего числа
    //не нарисовать «страница 2 из 5» и не понять, показывать ли кнопку «дальше».
    public async countCatalog(search: string): Promise<number> {
        const rows = await this.pool.query<CountRow[]>(
            `
                SELECT COUNT(*) AS total
                FROM monitored_servers
                WHERE enabled = ?
                  AND (? = '' OR name LIKE CONCAT('%', ?, '%'))
            `,
            [true, search, search],
        );

        return Number(rows[0]?.total ?? 0);
    }

    //Серверы по списку id — для показа чужих подписок именами, а не номерами.
    //Условия enabled здесь НЕТ намеренно: сервер могли скрыть из каталога уже после подписки,
    //и человек обязан увидеть его в своём списке, хотя бы чтобы отписаться.
    public async findByIds(ids: readonly number[]): Promise<CatalogServer[]> {
        //IN () — синтаксическая ошибка, а не пустая выдача. Проверка обязательна.
        if (ids.length === 0) {
            return [];
        }

        const rows = await this.pool.query<ServerRow[]>(
            `
                SELECT id,
                       name,
                       game_address AS gameAddress
                FROM monitored_servers
                WHERE id IN (?)
                ORDER BY name, id
            `,
            [ids],
        );

        return rows.map(toCatalogServer);
    }

    //Один сервер со своими источниками — для разовой проверки по кнопке в боте.
    //Условия на подписку здесь НЕТ намеренно: смысл проверки в том, чтобы посмотреть на сервер,
    //за которым никто не следит. enabled остаётся: скрытый из каталога сервер проверять нечего.
    //undefined — сервера нет или он выключен. Пустые sources — опрашивать нечем; что с этим делать,
    //решает домен (buildMonitorConfigs), как и для findMonitored.
    public async findStoredById(id: number): Promise<StoredServer | undefined> {
        const [server] = await this.pool.query<ServerRow[]>(
            `
                SELECT id,
                       name,
                       game_address AS gameAddress
                FROM monitored_servers
                WHERE id = ?
                  AND enabled = ?
            `,
            [id, true],
        );

        if (!server) {
            return undefined;
        }

        const sources = await this.pool.query<SourceRow[]>(
            `
                SELECT id,
                       server_id    AS serverId,
                       role,
                       priority,
                       query_type   AS queryType,
                       query_config AS queryConfig
                FROM server_query_sources
                WHERE server_id = ?
                  AND enabled = ?
            `,
            [id, true],
        );

        return {
            id: Number(server.id),
            name: server.name,
            gameAddress: server.gameAddress,
            sources: sources.map(toQuerySource),
        };
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

            sources.push(toQuerySource(row));

            byServer.set(serverId, sources);
        }

        return byServer;
    }
}

//Строка источника → доменный источник. Одно место на оба чтения (список опроса и один сервер),
//чтобы разбор query_config и перевод bigint не разъехались.
function toQuerySource(row: SourceRow): ServerQuerySource {
    return {
        id: Number(row.id),
        role: row.role,
        priority: Number(row.priority),
        query: parseQueryConfig(row),
    };
}

//bigint у драйвера — деталь протокола, домену он не нужен. Тот же перевод, что и в остальных чтениях.
function toCatalogServer(row: ServerRow): CatalogServer {
    return {
        id: Number(row.id),
        name: row.name,
        gameAddress: row.gameAddress,
    };
}
