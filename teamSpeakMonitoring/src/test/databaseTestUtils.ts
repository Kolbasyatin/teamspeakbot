import {createConnection, type Pool} from "mariadb";
import type {Logger} from "pino";
import type {ServerQueryRole} from "../monitoring/MonitoredServer.js";
import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";
import {dbConfig} from "../properties.js";
import {readMigrationFiles} from "../persistence/migrationFiles.js";
import {Migrator} from "../persistence/Migrator.js";
import {MariaDbMigrationStore} from "../persistence/MariaDbMigrationStore.js";

//Каталог миграций относительно этого файла — тот же источник, что у прод-мигратора.
//Раньше здесь лежала копия CREATE TABLE, и она успела разъехаться с настоящей схемой:
//`primary key` был объявлен дважды, из-за чего на чистой базе тест не работал вовсе.
const migrationsDirectory = new URL("../migrations/", import.meta.url);

//Логи мигратора в прогоне тестов не нужны, а глушить глобальный логгер переменной окружения —
//значит глушить и всё остальное.
const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
} as unknown as Logger;

//Предохранитель. Тесты делают TRUNCATE, поэтому попадание не в ту базу означает потерю данных.
//Проверка по имени грубая, зато срабатывает раньше первого запроса: достаточно ошибиться
//в .env.test.local или запустить прогон с чужим DB_NAME.
export function assertTestDatabase(database: string): void {
    if (!database.endsWith("_test")) {
        throw new Error(
            `Refusing to run tests against database "${database}": name must end with "_test". `
            + "Проверь DB_NAME в .env.test / .env.test.local.",
        );
    }
}

//Приводит тестовую базу к актуальной схеме тем же мигратором, что работает в проде.
//Подключение своё, с multipleStatements: миграция вправе содержать несколько инструкций,
//а пул приложения так не настроен — ровно как в проде, где мигратор ходит отдельным процессом.
export async function migrateTestDatabase(): Promise<void> {
    assertTestDatabase(dbConfig.database);

    const {connectionLimit: _connectionLimit, ...connectionConfig} = dbConfig;
    const connection = await createConnection({...connectionConfig, multipleStatements: true});

    try {
        const files = await readMigrationFiles(migrationsDirectory);
        await new Migrator(new MariaDbMigrationStore(connection), files, silentLogger).run();
    } finally {
        await connection.end();
    }
}

//schema_migrations намеренно не чистим: это состояние схемы, а не данные теста.
//DELETE, а не TRUNCATE: на monitored_servers ссылается server_query_sources, и InnoDB
//не даёт усечь таблицу под внешним ключом. Источники уносит ON DELETE CASCADE.
//Отключать FOREIGN_KEY_CHECKS нельзя: настройка сессионная, а pool раздаёт разные соединения.
export async function truncateTestDatabase(pool: Pool): Promise<void> {
    assertTestDatabase(dbConfig.database);

    await pool.query("DELETE FROM monitored_servers");
}

//Один источник опроса в фикстуре. role и priority со значениями по умолчанию: тестам,
//которым безразличен выбор главного, не приходится их указывать.
export interface QuerySourceFixture {
    query: ServerQueryConfig;
    role?: ServerQueryRole;
    priority?: number;
    enabled?: boolean;
}

//Возвращает id вставленного сервера: тестам про несколько источников он нужен, чтобы
//сопоставить выдачу репозитория с тем, что они вставили.
export async function insertMonitoredServerFixture(
    pool: Pool,
    fixture: {
        name: string;
        gameAddress: string;
        sources: QuerySourceFixture[];
        enabled?: boolean;
    },
): Promise<number> {
    const inserted = await pool.query(
        `
            INSERT INTO monitored_servers
                (name, game_address, enabled)
            VALUES (?, ?, ?)
        `,
        [fixture.name, fixture.gameAddress, fixture.enabled ?? true],
    );

    const serverId = Number(inserted.insertId);

    for (const source of fixture.sources) {
        await pool.query(
            `
                INSERT INTO server_query_sources
                    (server_id, role, priority, query_type, query_config, enabled)
                VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
                serverId,
                source.role ?? "primary",
                source.priority ?? 0,
                source.query.type,
                JSON.stringify(source.query),
                source.enabled ?? true,
            ],
        );
    }

    return serverId;
}
