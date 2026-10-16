import test from "node:test";
import assert from "node:assert/strict";
import {AccessControl, type RoleAssignment, type RoleStore, type StoredGrantResult} from "./AccessControl.js";
import type {Permission, Role} from "./Roles.js";
import {silentLogger} from "../test/silentLogger.js";

const ROOT = 1;
const ADMIN = 2;
const USER = 3;

//Хранилище в памяти: проверяется правило доступа, а не SQL (его проверяет RoleRepository.test.ts).
class MemoryRoleStore implements RoleStore {
    public readonly roles = new Map<number, Set<string>>();
    public readonly chats = new Set<number>([ROOT, ADMIN, USER]);
    public readonly defaultGranted = new Set<number>();
    public reads = 0;

    public async findRoles(chatId: number): Promise<string[]> {
        this.reads++;
        return [...this.roles.get(chatId) ?? []];
    }

    public async findAssignments(): Promise<RoleAssignment[]> {
        return [];
    }

    public async findAssignmentsByChat(): Promise<RoleAssignment[]> {
        return [];
    }

    public async grant(chatId: number, role: Role): Promise<StoredGrantResult> {
        if (!this.chats.has(chatId)) {
            return "unknownChat";
        }

        const roles = this.roles.get(chatId) ?? new Set();

        if (roles.has(role)) {
            return "alreadyGranted";
        }

        roles.add(role);
        this.roles.set(chatId, roles);

        return "granted";
    }

    public async revoke(chatId: number, role: Role): Promise<boolean> {
        return this.roles.get(chatId)?.delete(role) ?? false;
    }

    public async grantDefaultOnce(chatId: number, role: Role): Promise<boolean> {
        if (this.defaultGranted.has(chatId)) {
            return false;
        }

        this.defaultGranted.add(chatId);
        await this.grant(chatId, role);

        return true;
    }
}

function createAccess(store = new MemoryRoleStore()): {
    access: AccessControl;
    store: MemoryRoleStore;
    lost: {chatId: number; lost: Permission[]}[];
} {
    const lost: {chatId: number; lost: Permission[]}[] = [];
    const access = new AccessControl(store, new Set([ROOT]), async (chatId, permissions) => {
        lost.push({chatId, lost: [...permissions].sort()});
    }, silentLogger);

    return {access, store, lost};
}

//Права раздаёт человек: его личные права — права его лички, user_id равен её chat_id.
const actor = (userId: number) => ({userId});

test("root из конфига — root даже при пустой базе", async () => {
    const {access} = createAccess();

    assert.deepEqual(await access.rolesOf(ROOT), ["ROLE_ROOT"]);
    assert.ok(await access.can(ROOT, "ROLE_ACCESS_MANAGE"));
});

test("root нельзя запереть: ROLE_ROOT не отзывается никем, даже root", async () => {
    const {access} = createAccess();

    const change = await access.revoke(actor(ROOT), ROOT, "ROLE_ROOT");

    assert.deepEqual(change, {result: "refused", reason: "rootOnlyFromConfig"});
    assert.ok(await access.can(ROOT, "ROLE_PLAYER_DOSSIER"));
});

test("выданная роль сразу видна: кэш сбрасывается при выдаче", async () => {
    const {access} = createAccess();

    assert.equal(await access.can(USER, "ROLE_PLAYER_WATCH"), false);

    const change = await access.grant(actor(ROOT), USER, "ROLE_PLAYER_USER", undefined);

    assert.deepEqual(change, {result: "granted"});
    assert.equal(await access.can(USER, "ROLE_PLAYER_WATCH"), true);
});

test("проверка на каждый апдейт не ходит в базу повторно", async () => {
    const {access, store} = createAccess();

    await access.can(USER, "ROLE_SERVER_LIST");
    await access.can(USER, "ROLE_SERVER_LIST");
    await access.can(USER, "ROLE_PLAYER_WATCH");

    assert.equal(store.reads, 1);
});

test("отзыв сообщает, какие права чат потерял", async () => {
    const {access, lost} = createAccess();

    await access.grant(actor(ROOT), USER, "ROLE_SERVER_USER", undefined);
    await access.grant(actor(ROOT), USER, "ROLE_PLAYER_WATCH", undefined);
    await access.revoke(actor(ROOT), USER, "ROLE_PLAYER_WATCH");

    assert.deepEqual(lost, [{chatId: USER, lost: ["ROLE_PLAYER_WATCH"]}]);
    assert.equal(await access.can(USER, "ROLE_PLAYER_WATCH"), false);
});

test("право, оставшееся от другой роли, потерянным не считается", async () => {
    //Иначе отзыв отдельного права у того, у кого оно есть и в группе, снёс бы ему подписки.
    const {access, lost} = createAccess();

    await access.grant(actor(ROOT), USER, "ROLE_PLAYER_USER", undefined);
    await access.grant(actor(ROOT), USER, "ROLE_PLAYER_WATCH", undefined);
    await access.revoke(actor(ROOT), USER, "ROLE_PLAYER_WATCH");

    assert.deepEqual(lost, []);
    assert.ok(await access.can(USER, "ROLE_PLAYER_WATCH"));
});

test("админ не выдаёт админа и того, чего нет у него", async () => {
    const {access} = createAccess();

    await access.grant(actor(ROOT), ADMIN, "ROLE_USER_ADMIN", undefined);

    assert.deepEqual(
        await access.grant(actor(ADMIN), USER, "ROLE_USER_ADMIN", undefined),
        {result: "refused", reason: "adminOnlyByRoot"},
    );
    assert.deepEqual(
        await access.grant(actor(ADMIN), USER, "ROLE_PLAYER_USER", undefined),
        {result: "refused", reason: "exceedsOwn"},
    );
    assert.deepEqual(await access.grant(actor(ADMIN), USER, "ROLE_SERVER_USER", undefined), {result: "granted"});
});

test("админ не снимает с другого то, чего не мог бы выдать", async () => {
    const {access} = createAccess();

    await access.grant(actor(ROOT), ADMIN, "ROLE_USER_ADMIN", undefined);
    await access.grant(actor(ROOT), USER, "ROLE_PLAYER_USER", undefined);

    assert.deepEqual(
        await access.revoke(actor(ADMIN), USER, "ROLE_PLAYER_USER"),
        {result: "refused", reason: "exceedsOwn"},
    );
    assert.ok(await access.can(USER, "ROLE_PLAYER_WATCH"));
});

test("роль по умолчанию выдаётся один раз: отозванная не возвращается повторным /start", async () => {
    const {access} = createAccess();

    assert.equal(await access.grantDefaultOnce(USER), true);
    assert.ok(await access.can(USER, "ROLE_SERVER_LIST"));

    await access.revoke(actor(ROOT), USER, "ROLE_SERVER_USER");

    assert.equal(await access.grantDefaultOnce(USER), false);
    assert.equal(await access.can(USER, "ROLE_SERVER_LIST"), false);
});

test("роль из базы, которой нет в коде, игнорируется, а не даёт доступ", async () => {
    const store = new MemoryRoleStore();

    store.roles.set(USER, new Set(["ROLE_SUPER_USER", "ROLE_TS_VIEW"]));

    const {access} = createAccess(store);

    assert.deepEqual(await access.rolesOf(USER), ["ROLE_TS_VIEW"]);
});
