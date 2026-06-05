import {EventEmitter} from "node:events";
import {createServer, type Server} from "node:http";
import {log} from "../logger.js";

export interface AdminHttpServerOptions {
    port: number;
    token?: string;
}

type AdminServerEvent = "syncMonitorServers" | "forceSyncMonitorServers";

export class AdminServer extends EventEmitter {
    private readonly server: Server;
    private readonly routes = new Map<string, AdminServerEvent>([
        ["/internal/reload-servers", "syncMonitorServers"],
        ["/internal/force-reload-servers", "forceSyncMonitorServers"]
    ])

    constructor(
        private readonly options: AdminHttpServerOptions
    ) {
        super();

        this.server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            const eventName = this.matchRoute(req.method, url.pathname);

            if (!eventName) {
                res.writeHead(404);
                res.end();
                return;
            }

            if (!this.isAuthorized(req.headers.authorization)) {
                res.writeHead(401);
                res.end();
                return;
            }

            res.writeHead(204);
            res.end();

            //Тут какая-то залупа с асинхронность, хз как это работает.
            setImmediate(() => {
                this.emit(eventName);
            });
        });
    }

    public start(): Promise<void> {
        return new Promise(resolve => {
            const port = this.options.port;
            const host = "0.0.0.0";
            this.server.listen(port, host, () => {
                log.info(`Admin server listening on ${host}:${port}`);
                resolve();
            });
        });
    }

    public stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server.close(error => {
                if (error) {
                    reject(error);
                    return;
                }
                log.info("Admin server stopped");
                resolve();
            });
        });
    }

    private isAuthorized(header: string | undefined): boolean {
        if (!this.options.token) {
            return true;
        }

        return header === `Bearer ${this.options.token}`;
    }

    private matchRoute(method: string | undefined, pathname: string): AdminServerEvent | undefined {
        if (method !== "POST") {
            return undefined;
        }
        return this.routes.get(pathname);
    }
}
