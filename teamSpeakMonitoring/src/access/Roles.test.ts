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
    "ROLE_PLAYER_QUEUE",
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
});

test("/who не по умолчанию: кто сейчас в TeamSpeak, видят только те, кому выдали", () => {
    assert.ok(!DEFAULT_PERMISSIONS.has("ROLE_TS_VIEW"));
    assert.ok(!permissionsOfRole("ROLE_PLAYER_USER").has("ROLE_TS_VIEW"));
    assert.ok(!permissionsOfRole("ROLE_USER_ADMIN").has("ROLE_TS_VIEW"));
    assert.ok(permissionsOfRole("ROLE_TS_USER").has("ROLE_TS_VIEW"));
});

test("список чатов, обратная связь и рассылки — только у root, ни у одной другой группы", () => {
    for (const permission of ["ROLE_CHAT_LIST", "ROLE_FEEDBACK_VIEW", "ROLE_BROADCAST"] as const) {
        assert.ok(permissionsOfRole("ROLE_ROOT").has(permission));

        for (const group of ROLE_GROUPS) {
            if (group !== "ROLE_ROOT") {
                assert.ok(!permissionsOfRole(group).has(permission), `${group} не должна давать ${permission}`);
            }
        }
    }
});

test("группу TeamSpeak выдаёт root и админ, у которого она есть; админ без неё — нет", () => {
    const root = permissionsOfRoles(["ROLE_ROOT"]);
    const admin = permissionsOfRoles(["ROLE_USER_ADMIN"]);
    const adminWithTs = permissionsOfRoles(["ROLE_USER_ADMIN", "ROLE_TS_USER"]);

    assert.equal(manageRefusal(root, true, "ROLE_TS_USER"), undefined);
    assert.equal(manageRefusal(admin, false, "ROLE_TS_USER"), "exceedsOwn");
    assert.equal(manageRefusal(adminWithTs, false, "ROLE_TS_USER"), undefined);
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
    assert.equal(parseRole("ts_user"), "ROLE_TS_USER");
    assert.equal(parseRole("superuser"), undefined);
});
