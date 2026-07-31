import type {Pool} from "mariadb";
import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";

export async function migrateTestDatabase(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS monitored_servers
        (
            id           bigint unsigned auto_increment
                primary key,
            name         varchar(255)                           not null,
            game_address varchar(255)                           not null,
            query_type   varchar(32)                            not null,
            query_config longtext collate utf8mb4_bin           not null
                check (json_valid(\`query_config\`)),
            enabled      tinyint(1) default 1                   not null,
            created_at   timestamp  default current_timestamp() not null,
            updated_at   timestamp  default current_timestamp() not null on update current_timestamp()
        )
    `);
}

export async function truncateTestDatabase(pool: Pool): Promise<void> {
    await pool.query("TRUNCATE TABLE monitored_servers");
}

export async function insertMonitoredServerFixture(
    pool: Pool,
    fixture: {
        name: string;
        gameAddress: string;
        query: ServerQueryConfig;
        enabled?: boolean;
    },
): Promise<void> {
    await pool.query(
        `
            INSERT INTO monitored_servers
                (name, game_address, query_type, query_config, enabled)
            VALUES (?, ?, ?, ?, ?)
        `,
        [
            fixture.name,
            fixture.gameAddress,
            fixture.query.type,
            JSON.stringify(fixture.query),
            fixture.enabled ?? true,
        ],
    );
}