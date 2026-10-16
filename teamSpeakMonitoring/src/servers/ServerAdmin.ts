import type {ServerQueryRole} from "../monitoring/MonitoredServer.js";
import {gameAddressProblem, isQueryType, QUERY_TYPES, validateQueryConfig} from "../monitoring/validateQueryConfig.js";
import {applyParams, buildNewConfig} from "./sourceForms.js";
import type {
    AdminServer,
    AdminServerSummary,
    AdminSource,
    ServerAdminStore,
    ServerPatch,
    SourcePatch,
} from "./ServerAdminModel.js";

//Управление списком серверов: что можно поменять и при каких условиях. Транспорта не знает —
//параметры приходят плоским «ключ=значение», ответ — данные или перечень проблем человеческим текстом.
//
//Главное, что здесь стережётся, — инварианты, на которых держится опрос:
//  у сервера не больше одного включённого primary — два роняют сборку всего списка опроса
//    (resolvePrimarySource бросает исключение, и не опрашивается никто);
//  у включённого сервера есть включённый источник с пригодным конфигом — иначе он виден
//    подписчикам, но опрашивать его нечем.
//Проверяются они одинаково для любой правки: строится состояние «как станет», и проверяется оно.

export type AdminResult<T> = {ok: true; value: T} | {ok: false; problems: string[]};

export type AdminParams = Readonly<Record<string, string>>;

const MAX_NAME_LENGTH = 255;

//Эти ключи общие для всех типов и в конфиг источника не идут.
const SOURCE_KEYS = new Set(["role", "priority", "enabled"]);

export class ServerAdmin {
    public constructor(
        private readonly store: ServerAdminStore,
        //Список опроса изменился — что с этим делать, знает composition root.
        private readonly onChanged: () => Promise<void>,
    ) {
    }

    public server(id: number): Promise<AdminServer | undefined> {
        return this.store.findServer(id);
    }

    public source(id: number): Promise<AdminSource | undefined> {
        return this.store.findSource(id);
    }

    public async summaries(search: string, limit: number, offset: number): Promise<{servers: AdminServerSummary[]; total: number}> {
        return {
            servers: await this.store.findSummaryPage(search, limit, offset),
            total: await this.store.countSummaries(search),
        };
    }

    //Новый сервер — черновик: выключен, пока у него нет источника. Включить его — отдельное решение.
    public async createServer(name: string, gameAddress: string): Promise<AdminResult<number>> {
        const problems = [nameProblem(name), gameAddressProblem(gameAddress.trim(), "адрес")]
            .filter(problem => problem !== undefined);

        if (problems.length > 0) {
            return {ok: false, problems};
        }

        const id = await this.store.createServer(name.trim(), gameAddress.trim());

        //Выключенный сервер опрос не меняет, но список держим честным в любом случае: дёшево.
        await this.onChanged();

        return {ok: true, value: id};
    }

    public async editServer(id: number, params: AdminParams): Promise<AdminResult<AdminServer>> {
        const server = await this.store.findServer(id);

        if (!server) {
            return {ok: false, problems: [`сервера #${id} нет`]};
        }

        const problems: string[] = [];
        const patch: ServerPatch = {};

        for (const [key, value] of Object.entries(params)) {
            const problem = applyServerParam(patch, key, value);

            if (problem) {
                problems.push(problem);
            }
        }

        if (problems.length === 0 && Object.keys(patch).length === 0) {
            problems.push("нечего менять: укажите name=…, address=…, enabled=on|off или position=N|off");
        }

        if (patch.enabled === true && !hasUsableSource(server.sources)) {
            problems.push("нельзя включить: нет включённого источника с пригодным конфигом");
        }

        if (problems.length > 0) {
            return {ok: false, problems};
        }

        await this.store.updateServer(id, patch);
        await this.onChanged();

        const {listPosition, ...rest} = patch;

        return {
            ok: true,
            value: {
                ...server,
                ...rest,
                ...(listPosition === undefined ? {} : {listPosition: listPosition ?? undefined}),
            },
        };
    }

    public async deleteServer(id: number): Promise<AdminResult<void>> {
        if (!await this.store.findServer(id)) {
            return {ok: false, problems: [`сервера #${id} нет`]};
        }

        await this.store.deleteServer(id);
        await this.onChanged();

        return {ok: true, value: undefined};
    }

    //Роль и приоритет по умолчанию — чтобы обычный случай вводился одной строкой:
    //первый источник становится primary, следующие — secondary с приоритетом ниже предыдущих.
    public async addSource(serverId: number, rawType: string, params: AdminParams): Promise<AdminResult<number>> {
        const server = await this.store.findServer(serverId);

        if (!server) {
            return {ok: false, problems: [`сервера #${serverId} нет`]};
        }

        if (!isQueryType(rawType)) {
            return {ok: false, problems: [`неизвестный тип источника «${rawType}»; есть: ${QUERY_TYPES.join(", ")}`]};
        }

        const {common, config: configParams} = splitSourceParams(params);
        const problems = [...common.problems];
        const built = buildNewConfig(rawType, configParams, server.gameAddress);
        const validation = validateQueryConfig(built.raw);

        problems.push(...built.problems, ...(validation.ok ? [] : validation.problems));

        const hasPrimary = server.sources.some(source => source.enabled && source.role === "primary");
        const source = {
            role: common.role ?? (hasPrimary ? "secondary" : "primary"),
            priority: common.priority ?? nextPriority(server.sources),
            enabled: common.enabled ?? true,
        } as const;

        if (!validation.ok || problems.length > 0) {
            return {ok: false, problems};
        }

        const invariant = invariantProblems(server, [...server.sources, {
            ...source,
            id: 0,
            serverId,
            queryType: rawType,
            raw: built.raw,
            config: validation.config,
            problem: undefined,
        }]);

        if (invariant.length > 0) {
            return {ok: false, problems: invariant};
        }

        const id = await this.store.createSource(serverId, {...source, config: validation.config});

        await this.onChanged();

        return {ok: true, value: id};
    }

    //Тип источника не меняется: у разных типов разные параметры, и «правка» a2s в rest — это
    //удаление и новый источник, а не правка.
    public async editSource(sourceId: number, params: AdminParams): Promise<AdminResult<AdminSource>> {
        const source = await this.store.findSource(sourceId);
        const server = source ? await this.store.findServer(source.serverId) : undefined;

        if (!source || !server) {
            return {ok: false, problems: [`источника #${sourceId} нет`]};
        }

        if (!isQueryType(source.queryType)) {
            return {ok: false, problems: [`у источника #${sourceId} неизвестный тип «${source.queryType}» — его можно только удалить`]};
        }

        if ("type" in params) {
            return {ok: false, problems: ["тип источника не меняется — удалите источник и добавьте новый"]};
        }

        const {common, config: configParams} = splitSourceParams(params);
        const problems = [...common.problems];
        const patch: SourcePatch = {
            ...(common.role === undefined ? {} : {role: common.role}),
            ...(common.priority === undefined ? {} : {priority: common.priority}),
            ...(common.enabled === undefined ? {} : {enabled: common.enabled}),
        };
        let next: AdminSource = {...source, ...patch};

        if (Object.keys(configParams).length > 0) {
            const built = applyParams(source.queryType, source.raw ?? {}, configParams);
            const validation = validateQueryConfig(built.raw);

            problems.push(...built.problems, ...(validation.ok ? [] : validation.problems));

            if (validation.ok) {
                patch.config = validation.config;
                next = {...next, raw: built.raw, config: validation.config, problem: undefined};
            }
        }

        if (problems.length === 0 && Object.keys(patch).length === 0) {
            problems.push("нечего менять: укажите параметры источника, role=…, priority=… или enabled=on|off");
        }

        if (problems.length > 0) {
            return {ok: false, problems};
        }

        const invariant = invariantProblems(server, server.sources.map(item => item.id === sourceId ? next : item));

        if (invariant.length > 0) {
            return {ok: false, problems: invariant};
        }

        await this.store.updateSource(sourceId, patch);
        await this.onChanged();

        return {ok: true, value: next};
    }

    public async deleteSource(sourceId: number): Promise<AdminResult<void>> {
        const source = await this.store.findSource(sourceId);
        const server = source ? await this.store.findServer(source.serverId) : undefined;

        if (!source || !server) {
            return {ok: false, problems: [`источника #${sourceId} нет`]};
        }

        const invariant = invariantProblems(server, server.sources.filter(item => item.id !== sourceId));

        if (invariant.length > 0) {
            return {ok: false, problems: invariant};
        }

        await this.store.deleteSource(sourceId);
        await this.onChanged();

        return {ok: true, value: undefined};
    }
}

//Инварианты опроса на состоянии «как станет».
function invariantProblems(server: AdminServer, sources: readonly AdminSource[]): string[] {
    const problems: string[] = [];
    const primaries = sources.filter(source => source.enabled && source.role === "primary");

    if (primaries.length > 1) {
        const others = primaries.map(source => source.id === 0 ? "новый" : `#${source.id}`).join(", ");

        problems.push(`включённый primary может быть только один, а получится несколько (${others}): `
            + "два primary ломают сборку опроса. Сделайте лишний secondary или выключите его");
    }

    if (server.enabled && !hasUsableSource(sources)) {
        problems.push(`сервер #${server.id} включён, и опрашивать его станет нечем — сначала выключите сервер`);
    }

    return problems;
}

function hasUsableSource(sources: readonly AdminSource[]): boolean {
    return sources.some(source => source.enabled && source.config !== undefined);
}

function nextPriority(sources: readonly AdminSource[]): number {
    return sources.length === 0 ? 0 : Math.max(...sources.map(source => source.priority)) + 1;
}

interface CommonSourceParams {
    role: ServerQueryRole | undefined;
    priority: number | undefined;
    enabled: boolean | undefined;
    problems: string[];
}

//Один параметр сервера в правку. Возвращает проблему или undefined, если параметр принят.
function applyServerParam(patch: ServerPatch, key: string, value: string): string | undefined {
    if (key === "name") {
        const problem = nameProblem(value);

        if (!problem) {
            patch.name = value.trim();
        }

        return problem;
    }

    if (key === "address") {
        const problem = gameAddressProblem(value.trim(), "address");

        if (!problem) {
            patch.gameAddress = value.trim();
        }

        return problem;
    }

    if (key === "enabled") {
        const enabled = parseSwitch(value);

        if (enabled === undefined) {
            return "enabled: on или off";
        }

        patch.enabled = enabled;
        return undefined;
    }

    //Позиция в списках бота: меньше — выше; off или пусто — снять. Ноль и отрицательные не принимаются:
    //«первый» человек пишет как 1.
    if (key === "position") {
        const normalized = value.trim().toLowerCase();

        if (normalized === "" || normalized === "off") {
            patch.listPosition = null;
            return undefined;
        }

        if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
            return "position: целое число от 1 (меньше — выше) или off";
        }

        patch.listPosition = Number(normalized);
        return undefined;
    }

    return `неизвестный параметр «${key}»; есть: name, address, enabled, position`;
}

function splitSourceParams(params: AdminParams): {common: CommonSourceParams; config: Record<string, string>} {
    const common: CommonSourceParams = {role: undefined, priority: undefined, enabled: undefined, problems: []};
    const config: Record<string, string> = {};

    for (const [key, value] of Object.entries(params)) {
        if (!SOURCE_KEYS.has(key)) {
            config[key] = value;
            continue;
        }

        const problem = applyCommonParam(common, key, value);

        if (problem) {
            common.problems.push(problem);
        }
    }

    return {common, config};
}

function applyCommonParam(common: CommonSourceParams, key: string, value: string): string | undefined {
    if (key === "role") {
        if (value !== "primary" && value !== "secondary") {
            return "role: primary или secondary";
        }

        common.role = value;
        return undefined;
    }

    if (key === "priority") {
        if (!/^-?\d+$/.test(value)) {
            return "priority: целое число, меньше — важнее";
        }

        common.priority = Number(value);
        return undefined;
    }

    const enabled = parseSwitch(value);

    if (enabled === undefined) {
        return "enabled: on или off";
    }

    common.enabled = enabled;
    return undefined;
}

function nameProblem(name: string): string | undefined {
    const trimmed = name.trim();

    if (trimmed === "") {
        return "имя: не может быть пустым";
    }

    return trimmed.length > MAX_NAME_LENGTH ? `имя: не длиннее ${MAX_NAME_LENGTH} символов` : undefined;
}

function parseSwitch(value: string): boolean | undefined {
    const normalized = value.trim().toLowerCase();

    if (["on", "1", "true", "yes", "да", "вкл"].includes(normalized)) {
        return true;
    }

    return ["off", "0", "false", "no", "нет", "выкл"].includes(normalized) ? false : undefined;
}
