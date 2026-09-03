import {
    narrowQueryConfig,
    type Querier,
    type ServerQueryConfig,
    type ServerQueryResult,
} from "../monitoring/ServerQuery.js";
import {type ServerInfo, SourceQuery} from "@callowayisweird/source-query";
import type {Logger} from "pino";

//Единственное место в проекте, которому позволено знать тип ServerInfo из библиотеки A2S.
//Наружу отдаётся доменный ServerQueryResult.
export class A2sQuerier implements Querier {
    constructor(private readonly logger: Logger) {
    }

    public async query(config: ServerQueryConfig): Promise<ServerQueryResult | undefined> {
        const a2sConfig = narrowQueryConfig(config, "a2s");
        const query = new SourceQuery({
            host: a2sConfig.host,
            port: a2sConfig.port,
            timeout: a2sConfig.timeout,
        });

        try {
            return this.toQueryResult(await query.info());
        } catch (error) {
            this.logger.debug(`A2S query failed for ${a2sConfig.host}:${a2sConfig.port}`);
            return undefined;
        }
    }

    //A2S отдаёт 15 полей, домену нужны два. Остальное здесь и остаётся.
    private toQueryResult(info: ServerInfo): ServerQueryResult {
        return {
            players: info.players,
            maxPlayers: info.maxPlayers,
        };
    }
}
