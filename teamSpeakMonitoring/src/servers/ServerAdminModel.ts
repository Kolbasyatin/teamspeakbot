import type {ServerQueryRole, StoredServer} from "../monitoring/MonitoredServer.js";
import type {ServerQueryConfig} from "../monitoring/ServerQuery.js";

//Сервер и его источники глазами администратора. Отличие от StoredServer (взгляд опроса) и
//CatalogServer (взгляд подписчика) в том, что здесь видно ВСЁ: выключенные серверы, выключенные
//источники и источники с непригодным конфигом. Ради этого администратор и смотрит.

export const DEFAULT_SOURCE_TIMEOUT_MS = 5_000;

export interface AdminSource {
    id: number;
    serverId: number;
    role: ServerQueryRole;
    priority: number;
    enabled: boolean;
    //Тип, как он записан в query_type.
    queryType: string;
    //Конфиг как лежит в базе, разобранный из JSON. undefined — JSON не разбирается вовсе.
    //Нужен правке: изменённые параметры накладываются поверх него, даже если он непригоден.
    raw: Record<string, unknown> | undefined;
    //Пригодный конфиг или undefined, и тогда в problem — почему.
    config: ServerQueryConfig | undefined;
    problem: string | undefined;
}

export interface AdminServer {
    id: number;
    name: string;
    gameAddress: string;
    enabled: boolean;
    subscriberCount: number;
    //Все источники, в порядке приоритета.
    sources: AdminSource[];
}

//Строка админского списка: голые факты, без выводов. Вывод делает readinessOf.
export interface AdminServerSummary {
    id: number;
    name: string;
    gameAddress: string;
    enabled: boolean;
    enabledSourceCount: number;
    enabledPrimaryCount: number;
}

//Чего серверу не хватает, чтобы его опрашивали и видели подписчики.
export type ServerReadiness =
    //Включён, есть источник и primary.
    | "ready"
    //Выключен, но источники есть — включить можно.
    | "disabled"
    //Включённых источников нет: опрашивать нечем. У выключенного это черновик, у включённого — поломка.
    | "noSources"
    //Источники есть, но primary среди них нет: статус решает самый приоритетный из оставшихся.
    | "noPrimary";

export function readinessOf(server: Pick<AdminServerSummary, "enabled" | "enabledSourceCount" | "enabledPrimaryCount">): ServerReadiness {
    if (server.enabledSourceCount === 0) {
        return "noSources";
    }

    if (!server.enabled) {
        return "disabled";
    }

    return server.enabledPrimaryCount === 0 ? "noPrimary" : "ready";
}

//Сервер в той форме, в какой его опрашивают: только включённые источники с пригодным конфигом.
//Включён ли сам сервер, не важно — разовая проверка черновика ради этого и нужна.
export function checkableServer(server: AdminServer): StoredServer {
    return {
        id: server.id,
        name: server.name,
        gameAddress: server.gameAddress,
        sources: server.sources.flatMap(source => source.enabled && source.config
            ? [{id: source.id, role: source.role, priority: source.priority, query: source.config}]
            : []),
    };
}

export interface NewSource {
    role: ServerQueryRole;
    priority: number;
    enabled: boolean;
    config: ServerQueryConfig;
}

export interface ServerPatch {
    name?: string;
    gameAddress?: string;
    enabled?: boolean;
}

export interface SourcePatch {
    role?: ServerQueryRole;
    priority?: number;
    enabled?: boolean;
    config?: ServerQueryConfig;
}

//Хранилище глазами администрирования. Объявлено здесь, у потребителя.
//Читающий ServerRepository этим не занимается: у опроса и у админки разные вопросы к одним таблицам.
export interface ServerAdminStore {
    findServer(id: number): Promise<AdminServer | undefined>;

    findSource(id: number): Promise<AdminSource | undefined>;

    findSummaryPage(search: string, limit: number, offset: number): Promise<AdminServerSummary[]>;

    countSummaries(search: string): Promise<number>;

    //Новый сервер всегда выключен — это черновик, пока у него нет источников.
    createServer(name: string, gameAddress: string): Promise<number>;

    updateServer(id: number, patch: ServerPatch): Promise<void>;

    deleteServer(id: number): Promise<void>;

    createSource(serverId: number, source: NewSource): Promise<number>;

    updateSource(id: number, patch: SourcePatch): Promise<void>;

    deleteSource(id: number): Promise<void>;
}
