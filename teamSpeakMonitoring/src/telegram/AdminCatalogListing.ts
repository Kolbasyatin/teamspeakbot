import type {AdminServerSummary} from "../servers/ServerAdminModel.js";
import {readinessOf} from "../servers/ServerAdminModel.js";
import type {AccessChecker} from "./AccessGuard.js";
import type {AdminCatalog} from "./SubscriptionCommands.js";
import type {ListOrigin} from "./ServerListMessage.js";
import {encodeAdminButton, readinessIcon} from "./ServerAdminMessages.js";

//Сводки серверов для админского списка. Реализует servers/ServerAdmin.
export interface AdminSummaries {
    summaries(search: string, limit: number, offset: number): Promise<{servers: AdminServerSummary[]; total: number}>;
}

//Админский вид каталога для /serverlist: связывает обычный список с админкой, не давая им знать
//друг о друге. Список получает готовые значки и кнопки, админка — ничего не знает о списке.
export class AdminCatalogListing implements AdminCatalog {
    public constructor(
        private readonly access: AccessChecker,
        private readonly admin: AdminSummaries,
    ) {
    }

    public canSeeAll(chatId: number): Promise<boolean> {
        return this.access.can(chatId, "ROLE_SERVER_ADMIN_VIEW");
    }

    public async page(search: string, limit: number, offset: number): ReturnType<AdminCatalog["page"]> {
        const {servers, total} = await this.admin.summaries(search, limit, offset);

        return {
            servers: servers.map(({id, name, gameAddress}) => ({id, name, gameAddress})),
            total,
            //📌 — закреплён: так видно, почему сервер стоит выше остальных.
            marks: new Map(servers.map(server => [
                server.id,
                `${readinessIcon(readinessOf(server), server.enabled)}${server.listPosition === undefined ? "" : "📌"}`,
            ])),
        };
    }

    public openButton(serverId: number, origin: ListOrigin): string {
        return encodeAdminButton({action: "open", id: serverId, origin});
    }
}
