import "dotenv-flow/config";
import {createConnection} from "mariadb";
import {dbConfig} from "./properties.js";
import {log} from "./logger.js";
import {retry} from "./retry.js";
import {readMigrationFiles} from "./persistence/migrationFiles.js";
import {Migrator} from "./persistence/Migrator.js";
import {MariaDbMigrationStore} from "./persistence/MariaDbMigrationStore.js";

//Вторая точка входа рядом с main.ts. Отдельный процесс, а не шаг внутри приложения: применение схемы —
//разовая операция деплоя. Автоприменение из main сломалось бы, как только приложение поедет
//в нескольких экземплярах — они начали бы мигрировать базу одновременно.
//См. PLAN.md, «Миграции применяются отдельной командой, не из main».

//Каталог с SQL лежит рядом с этим файлом: в dev это src/migrations, в образе — dist/migrations
//(Dockerfile копирует их туда, потому что tsc .sql не переносит).
const migrationsDirectory = new URL("./migrations/", import.meta.url);

//База может подняться позже команды: в compose она стартует рядом. Те же параметры, что у стартового
//чтения серверов в main.ts.
const connectRetry = {
    attempts: 10,
    initialDelayMs: 1_000,
    maxDelayMs: 15_000,
} as const;

async function migrate(): Promise<void> {
    const files = await readMigrationFiles(migrationsDirectory);

    log.info({migrations: files.length, database: dbConfig.database}, "Мигратор запущен");

    //connectionLimit — параметр пула, одиночному подключению он не нужен.
    const {connectionLimit: _connectionLimit, ...connectionConfig} = dbConfig;

    const connection = await retry(
        () => createConnection({
            ...connectionConfig,
            //Файл миграции вправе содержать несколько инструкций.
            multipleStatements: true,
        }),
        {
            ...connectRetry,
            onRetry: (error, attempt, nextDelayMs) => {
                log.warn({error, attempt, nextDelayMs}, "Не удалось подключиться к БД, повторяю");
            },
        },
    );

    try {
        const applied = await new Migrator(
            new MariaDbMigrationStore(connection),
            files,
            log,
        ).run();

        if (applied.length > 0) {
            log.info({applied}, "Миграции применены");
        }
    } finally {
        await connection.end();
    }
}

try {
    await migrate();
} catch (error) {
    //Ненулевой код выхода обязателен: по нему деплой понимает, что приложение поднимать нельзя.
    log.fatal({error}, "Миграция не удалась");
    process.exit(1);
}
