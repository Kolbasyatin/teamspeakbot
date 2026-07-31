import type {AppliedMigration, MigrationStore} from "./Migrator.js";
import type {MigrationFile} from "./migrationFiles.js";

//Ровно то, что нужно от драйвера. Узкий интерфейс, а не тип mariadb: это единственное место,
//где мигратор касается базы, и подменить его в тесте должно быть возможно.
export interface SqlExecutor {
    query(sql: string, params?: unknown[]): Promise<unknown>;
}

type VersionRow = {version: number; name: string; checksum: string};

export class MariaDbMigrationStore implements MigrationStore {

    //Подключение должно быть с multipleStatements: файл миграции вправе содержать несколько
    //инструкций, а драйвер по умолчанию выполняет только одну на запрос.
    constructor(private readonly connection: SqlExecutor) {
    }

    public async ensureVersionTable(): Promise<void> {
        await this.connection.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations
            (
                version    int unsigned                           not null primary key,
                name       varchar(255)                           not null,
                checksum   char(64)                               not null,
                applied_at timestamp  default current_timestamp() not null
            )
        `);
    }

    public async getApplied(): Promise<AppliedMigration[]> {
        const rows = await this.connection.query(
            "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ) as VersionRow[];

        return rows.map(row => ({
            //Колонка int unsigned, но драйвер приводит числовые типы по-своему — Number честнее каста.
            version: Number(row.version),
            name: row.name,
            checksum: row.checksum,
        }));
    }

    public async apply(file: MigrationFile): Promise<void> {
        await this.connection.query(file.sql);

        //Записываем версию только после успешного применения: иначе упавшая миграция считалась бы
        //сделанной и повторить её было бы некому.
        await this.connection.query(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
            [file.version, file.name, file.checksum],
        );
    }
}
