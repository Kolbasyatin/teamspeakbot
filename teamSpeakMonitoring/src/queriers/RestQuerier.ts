import type {Querier} from "../a2s/ServerMonitor.js";
import type {RestQueryConfig, ServerQueryConfig} from "../a2s/config.js";
import type {ServerInfo} from "@callowayisweird/source-query";
import {log} from "../logger.js";

export class RestQuerier implements Querier {
    public async query(config: ServerQueryConfig): Promise<ServerInfo | undefined> {
        const restConfig = config as RestQueryConfig;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), restConfig.timeout);

        try {
            const response = await fetch(restConfig.url, {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            return {
                name: data.name,
                players: data.players,
                maxPlayers: data.maxPlayers,
            } as ServerInfo;
        } catch (error) {
            log.debug(`REST query failed for ${restConfig.url}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
