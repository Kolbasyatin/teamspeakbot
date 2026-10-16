import test from "node:test";
import assert from "node:assert/strict";
import {ServerAdmin, type AdminResult} from "./ServerAdmin.js";
import {
    checkableServer,
    readinessOf,
    type AdminServer,
    type AdminServerSummary,
    type AdminSource,
    type NewSource,
    type ServerAdminStore,
    type ServerPatch,
    type SourcePatch,
} from "./ServerAdminModel.js";

//Хранилище в памяти: проверяются правила администрирования, а не SQL (его проверяет
//ServerAdminRepository.test.ts по живой базе).
class MemoryStore implements ServerAdminStore {
    public readonly servers = new Map<number, Omit<AdminServer, "sources">>();
    public readonly sources = new Map<number, AdminSource>();
    private nextId = 1;

    public async findServer(id: number): Promise<AdminServer | undefined> {
        const server = this.servers.get(id);

        return server && {
            ...server,
            sources: [...this.sources.values()].filter(source => source.serverId === id)
                .sort((left, right) => left.priority - right.priority || left.id - right.id),
        };
    }

    public async findSource(id: number): Promise<AdminSource | undefined> {
        return this.sources.get(id);
    }

    public async findSummaryPage(): Promise<AdminServerSummary[]> {
        return [];
    }

    public async countSummaries(): Promise<number> {
        return this.servers.size;
    }

    public async createServer(name: string, gameAddress: string): Promise<number> {
        const id = this.nextId++;

        this.servers.set(id, {id, name, gameAddress, enabled: false, listPosition: undefined, subscriberCount: 0});

        return id;
    }

    public async updateServer(id: number, patch: ServerPatch): Promise<void> {
        const server = this.servers.get(id);

        if (server) {
            //null в правке — снять позицию, как NULL в колонке у настоящего хранилища.
            const {listPosition, ...rest} = patch;

            this.servers.set(id, {
                ...server,
                ...rest,
                ...(listPosition === undefined ? {} : {listPosition: listPosition ?? undefined}),
            });
        }
    }

    public async deleteServer(id: number): Promise<void> {
        this.servers.delete(id);
    }

    public async createSource(serverId: number, source: NewSource): Promise<number> {
        const id = this.nextId++;

        this.sources.set(id, {
            id,
            serverId,
            role: source.role,
            priority: source.priority,
            enabled: source.enabled,
            queryType: source.config.type,
            raw: {...source.config},
            config: source.config,
            problem: undefined,
        });

        return id;
    }

    public async updateSource(id: number, patch: SourcePatch): Promise<void> {
        const source = this.sources.get(id);

        if (source) {
            this.sources.set(id, {...source, ...patch, ...(patch.config ? {raw: {...patch.config}} : {})});
        }
    }

    public async deleteSource(id: number): Promise<void> {
        this.sources.delete(id);
    }
}

function setup(): {admin: ServerAdmin; store: MemoryStore; changes: () => number} {
    const store = new MemoryStore();
    let changes = 0;
    const admin = new ServerAdmin(store, async () => {
        changes++;
    });

    return {admin, store, changes: () => changes};
}

function valueOf<T>(result: AdminResult<T>): T {
    assert.ok(result.ok, result.ok ? "" : result.problems.join("; "));
    return result.value;
}

function problemsOf<T>(result: AdminResult<T>): string {
    assert.ok(!result.ok, "ожидался отказ");
    return result.problems.join("\n");
}

const ADDRESS = "37.48.253.41:2001";

test("новый сервер — черновик: выключен", async () => {
    const {admin, store} = setup();
    const id = valueOf(await admin.createServer("  #1 ARMA  ", ADDRESS));

    assert.deepEqual(store.servers.get(id), {
        id,
        name: "#1 ARMA",
        gameAddress: ADDRESS,
        enabled: false,
        listPosition: undefined,
        subscriberCount: 0,
    });
});

test("сервер без имени или с кривым адресом не создаётся", async () => {
    const {admin, store} = setup();

    const problems = problemsOf(await admin.createServer(" ", "37.48.253.41"));

    assert.match(problems, /имя/);
    assert.match(problems, /адрес/);
    assert.equal(store.servers.size, 0);
});

test("черновик без источника не включается", async () => {
    const {admin} = setup();
    const id = valueOf(await admin.createServer("S", ADDRESS));

    assert.match(problemsOf(await admin.editServer(id, {enabled: "on"})), /нет включённого источника/);
});

test("первый источник — primary с умолчаниями от игрового адреса", async () => {
    //Обычный случай вводится одной строкой: хост A2S берётся из игрового адреса, таймаут по умолчанию.
    const {admin, store} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));
    const sourceId = valueOf(await admin.addSource(serverId, "a2s", {port: "17771"}));

    assert.deepEqual(store.sources.get(sourceId)?.config, {type: "a2s", host: "37.48.253.41", port: 17771, timeout: 5000});
    assert.equal(store.sources.get(sourceId)?.role, "primary");
    assert.equal(store.sources.get(sourceId)?.priority, 0);
});

test("следующий источник — secondary с приоритетом ниже", async () => {
    const {admin, store} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));

    valueOf(await admin.addSource(serverId, "a2s", {port: "17771"}));
    const bohemia = valueOf(await admin.addSource(serverId, "bohemia", {}));

    assert.equal(store.sources.get(bohemia)?.role, "secondary");
    assert.equal(store.sources.get(bohemia)?.priority, 1);
    assert.deepEqual(store.sources.get(bohemia)?.config, {type: "bohemia", hostAddress: ADDRESS, timeout: 5000});
});

test("с источником сервер включается", async () => {
    const {admin, store} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));

    valueOf(await admin.addSource(serverId, "a2s", {port: "17771"}));
    valueOf(await admin.editServer(serverId, {enabled: "on"}));

    assert.equal(store.servers.get(serverId)?.enabled, true);
});

test("непригодный конфиг не сохраняется, проблемы перечислены все", async () => {
    const {admin, store} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));
    const problems = problemsOf(await admin.addSource(serverId, "a2s", {port: "abc", prot: "1"}));

    assert.match(problems, /port/);
    assert.match(problems, /неизвестный параметр «prot»/);
    assert.equal(store.sources.size, 0);
});

test("второй включённый primary не допускается — он ломает сборку опроса", async () => {
    const {admin} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));

    valueOf(await admin.addSource(serverId, "a2s", {port: "17771"}));

    assert.match(problemsOf(await admin.addSource(serverId, "bohemia", {role: "primary"})), /только один/);
});

test("выключенный второй primary допустим, а включить его, пока есть первый, нельзя", async () => {
    const {admin} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));

    valueOf(await admin.addSource(serverId, "a2s", {port: "17771"}));
    const spare = valueOf(await admin.addSource(serverId, "a2s", {port: "17772", role: "primary", enabled: "off"}));

    assert.match(problemsOf(await admin.editSource(spare, {enabled: "on"})), /только один/);
});

test("у включённого сервера нельзя убрать последний источник", async () => {
    const {admin, store} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));
    const sourceId = valueOf(await admin.addSource(serverId, "a2s", {port: "17771"}));

    valueOf(await admin.editServer(serverId, {enabled: "on"}));

    assert.match(problemsOf(await admin.deleteSource(sourceId)), /сначала выключите сервер/);
    assert.match(problemsOf(await admin.editSource(sourceId, {enabled: "off"})), /сначала выключите сервер/);
    assert.ok(store.sources.has(sourceId));
});

test("у выключенного сервера последний источник убирается", async () => {
    const {admin, store} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));
    const sourceId = valueOf(await admin.addSource(serverId, "a2s", {port: "17771"}));

    valueOf(await admin.deleteSource(sourceId));

    assert.equal(store.sources.size, 0);
});

test("правка источника накладывается на текущий конфиг", async () => {
    const {admin, store} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));
    const sourceId = valueOf(await admin.addSource(serverId, "rest", {
        url: "https://e.com/api",
        "fields.players": "data.online",
    }));

    valueOf(await admin.editSource(sourceId, {"fields.maxPlayers": "data.cap", timeout: "3000"}));

    assert.deepEqual(store.sources.get(sourceId)?.config, {
        type: "rest",
        url: "https://e.com/api",
        timeout: 3000,
        fields: {players: "data.online", maxPlayers: "data.cap"},
    });

    //Пустое значение поля карты убирает его.
    valueOf(await admin.editSource(sourceId, {"fields.maxPlayers": ""}));
    assert.deepEqual(store.sources.get(sourceId)?.config?.type === "rest" && store.sources.get(sourceId)?.config, {
        type: "rest",
        url: "https://e.com/api",
        timeout: 3000,
        fields: {players: "data.online"},
    });
});

test("тип источника правкой не меняется", async () => {
    const {admin} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));
    const sourceId = valueOf(await admin.addSource(serverId, "a2s", {port: "17771"}));

    assert.match(problemsOf(await admin.editSource(sourceId, {type: "rest"})), /тип источника не меняется/);
});

test("непригодный источник из базы чинится правкой", async () => {
    //Источник, заведённый когда-то руками без port: администратор дописывает недостающее.
    const {admin, store} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));

    store.sources.set(50, {
        id: 50,
        serverId,
        role: "primary",
        priority: 0,
        enabled: true,
        queryType: "a2s",
        raw: {type: "a2s", host: "37.48.253.41", timeout: 5000},
        config: undefined,
        problem: "port: нужно целое число",
    });

    valueOf(await admin.editSource(50, {port: "17771"}));

    assert.deepEqual(store.sources.get(50)?.config, {type: "a2s", host: "37.48.253.41", port: 17771, timeout: 5000});
});

test("каждая успешная правка сообщает об изменении списка, отказ — нет", async () => {
    const {admin, changes} = setup();
    const serverId = valueOf(await admin.createServer("S", ADDRESS));

    await admin.addSource(serverId, "a2s", {port: "bad"});
    assert.equal(changes(), 1, "отказ не должен пересобирать опрос");

    valueOf(await admin.addSource(serverId, "a2s", {port: "17771"}));
    valueOf(await admin.editServer(serverId, {name: "Новое имя"}));
    valueOf(await admin.deleteServer(serverId));
    assert.equal(changes(), 4);
});

test("несуществующие сервер и источник — понятный отказ", async () => {
    const {admin} = setup();

    assert.match(problemsOf(await admin.editServer(9, {name: "x"})), /сервера #9 нет/);
    assert.match(problemsOf(await admin.addSource(9, "a2s", {})), /сервера #9 нет/);
    assert.match(problemsOf(await admin.editSource(9, {port: "1"})), /источника #9 нет/);
    assert.match(problemsOf(await admin.deleteServer(9)), /сервера #9 нет/);
});

test("готовность сервера выводится из фактов", () => {
    assert.equal(readinessOf({enabled: false, enabledSourceCount: 0, enabledPrimaryCount: 0}), "noSources");
    assert.equal(readinessOf({enabled: true, enabledSourceCount: 0, enabledPrimaryCount: 0}), "noSources");
    assert.equal(readinessOf({enabled: false, enabledSourceCount: 1, enabledPrimaryCount: 1}), "disabled");
    assert.equal(readinessOf({enabled: true, enabledSourceCount: 2, enabledPrimaryCount: 0}), "noPrimary");
    assert.equal(readinessOf({enabled: true, enabledSourceCount: 2, enabledPrimaryCount: 1}), "ready");
});

test("к проверке идут только включённые пригодные источники, даже у выключенного сервера", () => {
    //Разовая проверка черновика нужна ДО включения, поэтому enabled сервера не фильтрует.
    const config = {type: "a2s", host: "h", port: 1, timeout: 1} as const;
    const base = {serverId: 1, priority: 0, queryType: "a2s", raw: {}, problem: undefined} as const;

    assert.deepEqual(checkableServer({
        id: 1,
        name: "S",
        gameAddress: "h:2001",
        enabled: false,
        listPosition: undefined,
        subscriberCount: 0,
        sources: [
            {...base, id: 1, role: "primary", enabled: true, config},
            {...base, id: 2, role: "secondary", enabled: false, config},
            {...base, id: 3, role: "secondary", enabled: true, config: undefined, problem: "x"},
        ],
    }), {
        id: 1,
        name: "S",
        gameAddress: "h:2001",
        sources: [{id: 1, role: "primary", priority: 0, query: config}],
    });
});

test("позиция в списке: число от 1 ставит, off снимает, остальное — отказ", async () => {
    const {admin, store} = setup();
    const id = valueOf(await admin.createServer("S", ADDRESS));

    assert.equal(valueOf(await admin.editServer(id, {position: "1"})).listPosition, 1);
    assert.equal(store.servers.get(id)?.listPosition, 1);

    assert.equal(valueOf(await admin.editServer(id, {position: "off"})).listPosition, undefined);
    assert.equal(store.servers.get(id)?.listPosition, undefined);

    for (const bad of ["0", "-1", "top", "1.5"]) {
        assert.match(problemsOf(await admin.editServer(id, {position: bad})), /position/, `position=${bad}`);
    }
});
