import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_PERMISSIONS,
    PERMISSIONS,
    ROLE_GROUPS,
    manageRefusal,
    parseRole,
    permissionsOfRole,
    permissionsOfRoles,
    type Permission,
} from "./Roles.js";

const PLAYER_PERMISSIONS: readonly Permission[] = [
    "ROLE_PLAYER_WATCH",
    "ROLE_PLAYER_LIST",
    "ROLE_PLAYER_WHERE",
    "ROLE_PLAYER_HISTORY",
    "ROLE_PLAYER_ALIASES",
    "ROLE_PLAYER_DOSSIER",
];

test("группа наследует права вложенной группы транзитивно", () => {
    //ROOT -> PLAYER_USER -> SERVER_USER -> SERVER_LIST: три ступени, право обязано дойти.
    const root = permissionsOfRole("ROLE_ROOT");

    assert.ok(root.has("ROLE_SERVER_LIST"));
    assert.ok(root.has("ROLE_PLAYER_DOSSIER"));
    assert.ok(root.has("ROLE_ACCESS_MANAGE"));
});

test("root получает каждое право, которое вообще существует", () => {
    //Право, недостижимое из root, не может выдать никто: его нет ни у кого, а выдать можно
    //только то, что есть у самого.
    const root = permissionsOfRoles(["ROLE_ROOT"]);

    for (const permission of PERMISSIONS) {
        assert.ok(root.has(permission), `root без ${permission}`);
    }
});

test("роль по умолчанию — серверы, без игроков и без раздачи прав", () => {
    for (const permission of PLAYER_PERMISSIONS) {
        assert.ok(!DEFAULT_PERMISSIONS.has(permission), `по умолчанию не должно быть ${permission}`);
    }

    assert.ok(!DEFAULT_PERMISSIONS.has("ROLE_ACCESS_MANAGE"));
    assert.ok(DEFAULT_PERMISSIONS.has("ROLE_SERVER_SUBSCRIBE"));
    assert.ok(DEFAULT_PERMISSIONS.has("ROLE_TS_VIEW"));
});

test("аноним есть у всех, даже без единой роли", () => {
    assert.deepEqual([...permissionsOfRoles([])], ["ROLE_ANONYMOUS"]);
});

test("несколько ролей складываются", () => {
    const permissions = permissionsOfRoles(["ROLE_SERVER_USER", "ROLE_PLAYER_DOSSIER"]);

    assert.ok(permissions.has("ROLE_PLAYER_DOSSIER"));
    assert.ok(permissions.has("ROLE_SERVER_LIST"));
    assert.ok(!permissions.has("ROLE_PLAYER_WATCH"));
});

test("root выдаёт что угодно, кроме самого root", () => {
    const root = permissionsOfRoles(["ROLE_ROOT"]);

    for (const role of [...PERMISSIONS, ...ROLE_GROUPS]) {
        const refusal = manageRefusal(root, true, role);

        if (role === "ROLE_ROOT") {
            assert.equal(refusal, "rootOnlyFromConfig");
        } else if (role === "ROLE_ANONYMOUS") {
            assert.equal(refusal, "implicit");
        } else {
            assert.equal(refusal, undefined, `root не смог выдать ${role}`);
        }
    }
});

test("админ не выдаёт того, чего нет у него самого", () => {
    const admin = permissionsOfRoles(["ROLE_USER_ADMIN"]);

    assert.equal(manageRefusal(admin, false, "ROLE_SERVER_USER"), undefined);
    assert.equal(manageRefusal(admin, false, "ROLE_PLAYER_USER"), "exceedsOwn");
    assert.equal(manageRefusal(admin, false, "ROLE_PLAYER_WATCH"), "exceedsOwn");
});

test("админ с правами на игроков может их раздавать", () => {
    const admin = permissionsOfRoles(["ROLE_USER_ADMIN", "ROLE_PLAYER_USER"]);

    assert.equal(manageRefusal(admin, false, "ROLE_PLAYER_USER"), undefined);
});

test("право раздавать права выдаёт только root", () => {
    //Иначе любой админ плодил бы админов, и отозвать доступ стало бы невозможно.
    const admin = permissionsOfRoles(["ROLE_USER_ADMIN", "ROLE_PLAYER_USER"]);

    assert.equal(manageRefusal(admin, false, "ROLE_USER_ADMIN"), "adminOnlyByRoot");
    assert.equal(manageRefusal(admin, false, "ROLE_ACCESS_MANAGE"), "adminOnlyByRoot");
});

test("без права раздавать роли нельзя ничего", () => {
    assert.equal(manageRefusal(DEFAULT_PERMISSIONS, false, "ROLE_SERVER_LIST"), "noAccessManage");
});

test("роль пишут как удобно", () => {
    assert.equal(parseRole("player_user"), "ROLE_PLAYER_USER");
    assert.equal(parseRole("ROLE_PLAYER_USER"), "ROLE_PLAYER_USER");
    assert.equal(parseRole("Role_Ts_View"), "ROLE_TS_VIEW");
    assert.equal(parseRole("superuser"), undefined);
});
