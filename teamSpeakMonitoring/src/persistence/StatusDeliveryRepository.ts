import {type Pool} from "mariadb";
import type {StatusDelivery, StatusDeliveryStore} from "../notifications/StatusDeliveryJournal.js";

type DeliveryRow = {
    chatId: number | bigint;
    serverId: number | bigint;
    delivered: string;
};

//Какой статус сервера последним доставлен в чат (итерация 22). Строка на пару (чат, сервер),
//новое значение перезаписывает старое.
export class StatusDeliveryRepository implements StatusDeliveryStore {
    public constructor(private readonly pool: Pool) {
    }

    public async loadDeliveries(): Promise<StatusDelivery[]> {
        const rows = await this.pool.query<DeliveryRow[]>(
            `
                SELECT chat_id   AS chatId,
                       server_id AS serverId,
                       delivered
                FROM telegram_status_deliveries
            `,
        );

        return rows.map(row => ({
            chatId: Number(row.chatId),
            serverId: Number(row.serverId),
            delivered: row.delivered,
        }));
    }

    public async saveDelivery(delivery: StatusDelivery): Promise<void> {
        await this.pool.query(
            `
                INSERT INTO telegram_status_deliveries (chat_id, server_id, delivered)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE delivered    = VALUES(delivered),
                                        delivered_at = current_timestamp()
            `,
            [delivery.chatId, delivery.serverId, delivery.delivered],
        );
    }
}
