import type {Querier} from "../a2s/ServerMonitor.js";
import type {RestQueryConfig, ServerQueryConfig, ServerQueryResult} from "../a2s/config.js";
import {log} from "../logger.js";

export class RestQuerier implements Querier {
    public async query(config: ServerQueryConfig): Promise<ServerQueryResult | undefined> {
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

            return this.toQueryResult(await response.json(), restConfig.url);
        } catch (error) {
            log.debug(`REST query failed for ${restConfig.url}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    //response.json() возвращает any, поэтому форму ответа приходится проверять руками:
    //без этого в домен уйдёт players: undefined и сервер будет вечно рендериться как unknown.
    //Непригодный ответ приравнивается к неудачному опросу — контракт Querier это допускает.
    private toQueryResult(payload: unknown, url: string): ServerQueryResult | undefined {
        if (!payload || typeof payload !== "object") {
            log.debug(`REST query for ${url} returned a non-object payload`);
            return undefined;
        }

        const {players, maxPlayers} = payload as Record<string, unknown>;

        if (!Number.isFinite(players) || !Number.isFinite(maxPlayers)) {
            log.debug(`REST query for ${url} returned no usable players/maxPlayers`);
            return undefined;
        }

        return {
            players: players as number,
            maxPlayers: maxPlayers as number,
        };
    }
}
