import type {Logger} from "pino";
import type {MigrationFile} from "./migrationFiles.js";

//Что мигратору нужно от базы. Интерфейс объявлен здесь, у потребителя: сам Migrator ни про MariaDB,
//ни про драйвер не знает, поэтому проверяется без базы вообще.
export interface MigrationStore {
    //Таблица версий создаётся сама: первая миграция не может её описывать, иначе некуда записать,
    //что первая миграция применена.
    ensureVersionTable(): Promise<void>;

    getApplied(): Promise<AppliedMigration[]>;

    //Выполнить SQL миграции и записать её версию. Одной операцией сделать нельзя: DDL в MariaDB
    //не транзакционный, поэтому запись версии — отдельный шаг после успешного применения.
    apply(file: MigrationFile): Promise<void>;
}

export interface AppliedMigration {
    version: number;
    name: string;
    checksum: string;
}

//Применяет недостающие миграции по порядку. Если применять нечего — не делает ничего.
//Часов и процессов внутри нет: это просто последовательность решений, которую можно проверить
//на фейковом хранилище.
export class Migrator {

    constructor(
        private readonly store: MigrationStore,
        private readonly files: readonly MigrationFile[],
        private readonly logger: Logger,
    ) {
    }

    public async run(): Promise<number[]> {
        await this.store.ensureVersionTable();

        const applied = new Map(
            (await this.store.getApplied()).map(migration => [migration.version, migration]),
        );

        this.warnAboutUnknownApplied(applied);

        const appliedNow: number[] = [];

        for (const file of this.files) {
            const previous = applied.get(file.version);

            if (previous) {
                //Правка применённой миграции — это расхождение схем, которое иначе никто не заметит.
                //Отказываемся работать целиком, а не пропускаем: дальше применять нечего, состояние
                //базы уже не соответствует файлам.
                if (previous.checksum !== file.checksum) {
                    throw new Error(
                        `Migration ${file.version}_${file.name} changed after it was applied. `
                        + "Applied migrations must never be edited: add a new migration instead.",
                    );
                }

                continue;
            }

            this.logger.info({version: file.version, name: file.name}, "Applying migration");
            await this.store.apply(file);
            appliedNow.push(file.version);
        }

        if (appliedNow.length === 0) {
            this.logger.info("Схема актуальна, применять нечего");
        }

        return appliedNow;
    }

    //База впереди файлов: миграцию удалили из репозитория или подключились не к той базе.
    //Это предупреждение, а не отказ — схема при этом рабочая, просто её история неполна.
    private warnAboutUnknownApplied(applied: Map<number, AppliedMigration>): void {
        const knownVersions = new Set(this.files.map(file => file.version));

        for (const migration of applied.values()) {
            if (!knownVersions.has(migration.version)) {
                this.logger.warn(
                    {version: migration.version, name: migration.name},
                    "В базе применена миграция, которой нет среди файлов",
                );
            }
        }
    }
}
