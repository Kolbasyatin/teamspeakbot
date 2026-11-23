import {type Pool} from "mariadb";
import type {SavedServerState, ServerStateStore} from "../monitoring/ServerStateMemory.js";

type StateRow = {
    serverId: number | bigint;
    status: "online" | "offline";
    since: Date;
    confirmedAt: Date;
};

//Статусы серверов между рестартами (итерация 22). Только хранение: что из сохранённого
//восстанавливать, решает monitoring/ServerStateMemory.
export class ServerStateRepository implements ServerStateStore {
    public constructor(private readonly pool: Pool) {
    }

    public async loadStates(): Promise<SavedServerState[]> {
        const rows = await this.pool.query<StateRow[]>(
            `
                SELECT server_id    AS serverId,
                       status,
                       status_since AS since,
                       confirmed_at AS confirmedAt
                FROM server_status_state
            `,
        );

        return rows.map(row => ({
            serverId: Number(row.serverId),
            status: row.status,
            since: row.since,
            confirmedAt: row.confirmedAt,
        }));
    }

    //По строке на сервер, а не одним запросом, и через SELECT из monitored_servers: сервер, удалённый
    //между опросом и записью, иначе уронил бы внешним ключом запись — а так просто не вставится.
    //Серверов единицы, запись раз в минуту. Колонки в UPDATE квалифицированы: в запросе есть
    //вторая таблица.
    //
    //Перезаписывается только более новым подтверждением: тик и переход статуса пишут независимо,
    //и запоздавший тик со снимком до перехода иначе вернул бы старый статус. В MariaDB присваивания
    //ON DUPLICATE KEY UPDATE идут слева направо, поэтому confirmed_at — последним: условие
    //в первых двух ещё видит старое значение.
    public async saveStates(states: readonly SavedServerState[]): Promise<void> {
        for (const state of states) {
            await this.pool.query(
                `
                    INSERT INTO server_status_state (server_id, status, status_since, confirmed_at)
                    SELECT ?, ?, ?, ?
                    FROM monitored_servers
                    WHERE id = ?
                    ON DUPLICATE KEY UPDATE
                        status       = IF(VALUES(confirmed_at) >= server_status_state.confirmed_at,
                                          VALUES(status), server_status_state.status),
                        status_since = IF(VALUES(confirmed_at) >= server_status_state.confirmed_at,
                                          VALUES(status_since), server_status_state.status_since),
                        confirmed_at = GREATEST(VALUES(confirmed_at), server_status_state.confirmed_at)
                `,
                [state.serverId, state.status, state.since, state.confirmedAt, state.serverId],
            );
        }
    }
}
