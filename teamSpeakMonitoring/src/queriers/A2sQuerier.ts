import type {Querier} from "../a2s/ServerMonitor.js";
import type {A2sQueryConfig, ServerQueryConfig} from "../a2s/config.js";
import {type ServerInfo, SourceQuery} from "@callowayisweird/source-query";
import {log} from "../logger.js";

export class A2sQuerier implements Querier {
    public async query(config: ServerQueryConfig): Promise<ServerInfo | undefined> {
        const a2sConfig = config as A2sQueryConfig;
        const query = new SourceQuery({
            host: a2sConfig.host,
            port: a2sConfig.port,
            timeout: a2sConfig.timeout,
        });

        try {
            return await query.info();
        } catch (error) {
            log.debug(`A2S query failed for ${a2sConfig.host}:${a2sConfig.port}`);
            return undefined;
        }
    }
}
