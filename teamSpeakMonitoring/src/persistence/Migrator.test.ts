import test from "node:test";
import assert from "node:assert/strict";
import {Migrator, type AppliedMigration, type MigrationStore} from "./Migrator.js";
import {checksumOf, parseMigrationFileName, type MigrationFile} from "./migrationFiles.js";
import type {Logger} from "pino";

function file(version: number, name: string, sql = `-- ${version}`): MigrationFile {
    return {version, name, sql, checksum: checksumOf(sql)};
}

interface FakeStore extends MigrationStore {
    appliedSql: string[];
    versionTableCreated: boolean;
    failOn?: number;
}

function createStore(alreadyApplied: AppliedMigration[] = []): FakeStore {
    const applied = [...alreadyApplied];

    return {
        appliedSql: [],
        versionTableCreated: false,
        async ensureVersionTable(): Promise<void> {
            this.versionTableCreated = true;
        },
        async getApplied(): Promise<AppliedMigration[]> {
            return applied;
        },
        async apply(migration: MigrationFile): Promise<void> {
            if (this.failOn === migration.version) {
                throw new Error(`SQL error in migration ${migration.version}`);
            }

            this.appliedSql.push(migration.sql);
            applied.push({
                version: migration.version,
                name: migration.name,
                checksum: migration.checksum,
            });
        },
    } as FakeStore;
}

function createLogger(): {logger: Logger; warnings: string[]} {
    const warnings: string[] = [];

    const logger = {
        debug: () => {},
        info: () => {},
        error: () => {},
        warn: (_context: unknown, message: string) => warnings.push(message),
    } as unknown as Logger;

    return {logger, warnings};
}

test("на пустой базе применяются все миграции по порядку версий", async () => {
    const store = createStore();
    const files = [file(2, "second", "SQL 2"), file(1, "first", "SQL 1")];

    const applied = await new Migrator(store, files.toSorted((a, b) => a.version - b.version), createLogger().logger).run();

    assert.deepEqual(applied, [1, 2]);
    assert.deepEqual(store.appliedSql, ["SQL 1", "SQL 2"]);
    assert.equal(store.versionTableCreated, true, "таблица версий создаётся сама");
});

test("уже применённые миграции пропускаются", async () => {
    const first = file(1, "first", "SQL 1");
    const store = createStore([
        {version: first.version, name: first.name, checksum: first.checksum},
    ]);

    const applied = await new Migrator(store, [first, file(2, "second", "SQL 2")], createLogger().logger).run();

    assert.deepEqual(applied, [2], "применилась только новая");
    assert.deepEqual(store.appliedSql, ["SQL 2"]);
});

test("повторный запуск на актуальной схеме не делает ничего", async () => {
    const first = file(1, "first", "SQL 1");
    const store = createStore([
        {version: first.version, name: first.name, checksum: first.checksum},
    ]);

    const applied = await new Migrator(store, [first], createLogger().logger).run();

    assert.deepEqual(applied, []);
    assert.deepEqual(store.appliedSql, []);
});

test("правка применённой миграции — отказ, а не тихий пропуск", async () => {
    //Иначе прод и дев расходятся молча: версия в schema_migrations одна и та же, схема разная.
    const applied = file(1, "first", "SQL 1");
    const store = createStore([
        {version: applied.version, name: applied.name, checksum: applied.checksum},
    ]);
    const edited = file(1, "first", "SQL 1 -- дописали строку");

    await assert.rejects(
        () => new Migrator(store, [edited], createLogger().logger).run(),
        /changed after it was applied/,
    );
});

test("упавшая миграция останавливает применение и не помечается сделанной", async () => {
    const store = createStore();
    store.failOn = 2;

    await assert.rejects(
        () => new Migrator(store, [file(1, "first", "SQL 1"), file(2, "second"), file(3, "third")], createLogger().logger).run(),
        /SQL error in migration 2/,
    );

    assert.deepEqual(store.appliedSql, ["SQL 1"], "третья не применялась: порядок важнее полноты");
    assert.deepEqual(
        (await store.getApplied()).map(migration => migration.version),
        [1],
        "версия упавшей миграции не записана, поэтому следующий запуск её повторит",
    );
});

test("применённая в базе версия, которой нет среди файлов, даёт предупреждение, но не отказ", async () => {
    //База впереди файлов: миграцию удалили или подключились не к той базе. Схема при этом рабочая.
    const store = createStore([{version: 7, name: "from_future", checksum: "x"}]);
    const {logger, warnings} = createLogger();

    const applied = await new Migrator(store, [file(1, "first", "SQL 1")], logger).run();

    assert.deepEqual(applied, [1]);
    assert.deepEqual(warnings, ["В базе применена миграция, которой нет среди файлов"]);
});

test("имя файла разбирается на версию и имя", () => {
    assert.deepEqual(parseMigrationFileName("001_monitored_servers.sql"), {
        version: 1,
        name: "monitored_servers",
    });
});

test("файл с посторонним именем роняет разбор, а не игнорируется", () => {
    //Молча пропущенная миграция хуже отказа: схема окажется неполной без единого сообщения.
    for (const bad of ["monitored_servers.sql", "1-monitored.sql", "001_Monitored.sql", "readme.md"]) {
        assert.throws(() => parseMigrationFileName(bad), /Migration file name must look like/, bad);
    }
});
