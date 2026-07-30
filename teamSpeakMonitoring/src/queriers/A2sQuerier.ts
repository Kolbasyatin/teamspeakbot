import type {Querier} from "../a2s/ServerMonitor.js";
import type {A2sQueryConfig, ServerQueryConfig, ServerQueryResult} from "../a2s/config.js";
import {type ServerInfo, SourceQuery} from "@callowayisweird/source-query";
import {log} from "../logger.js";

//Единственное место в проекте, которому позволено знать тип ServerInfo из библиотеки A2S.
//Наружу отдаётся доменный ServerQueryResult.
export class A2sQuerier implements Querier {
    public async query(config: ServerQueryConfig): Promise<ServerQueryResult | undefined> {
        const a2sConfig = config as A2sQueryConfig;
        const query = new SourceQuery({
            host: a2sConfig.host,
            port: a2sConfig.port,
            timeout: a2sConfig.timeout,
        });

        try {
            return this.toQueryResult(await query.info());
        } catch (error) {
            log.debug(`A2S query failed for ${a2sConfig.host}:${a2sConfig.port}`);
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
