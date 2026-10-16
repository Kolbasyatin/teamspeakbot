//Права бота и группы прав. Состав живёт ЗДЕСЬ, в коде, а не в базе: повседневно меняется,
//КОМУ выдана роль, а не ЧТО она разрешает. В базе лежит только назначение «чат → роль»
//(миграция 009). Переложить команду в другую группу или завести новую — это выкат, а не UPDATE.
//
//Слово «роль» общее для обоих видов, как в Symfony: выдать можно и группу, и отдельное право.
//Отдельное право нужно, чтобы дать человеку ровно одну возможность, не придумывая под неё группу.

//Право — одна команда вместе с её кнопками. Какая команда какое право требует — карта
//в telegram/commandAccess.ts.
export const PERMISSIONS = [
    //Есть у всех и всегда, в базе не хранится: /start, /help, /whoami. Пол, ниже которого
    //не опускаются, — даже незнакомый чат может узнать, что это за бот и как попросить доступ.
    "ROLE_ANONYMOUS",
    "ROLE_SERVER_LIST",
    "ROLE_SERVER_SUBSCRIBE",
    "ROLE_SERVER_STATUS",
    "ROLE_SERVER_OBSERVED",
    "ROLE_TS_VIEW",
    "ROLE_PLAYER_WATCH",
    "ROLE_PLAYER_LIST",
    "ROLE_PLAYER_WHERE",
    "ROLE_PLAYER_HISTORY",
    "ROLE_PLAYER_ALIASES",
    "ROLE_PLAYER_DOSSIER",
    "ROLE_ACCESS_MANAGE",
    //Видеть в /serverlist всё: черновики, выключенные, внутренние id и источники. Проверяется
    //по ЧАТУ: список читают все, кто в чате, и что показать — зависит от аудитории.
    "ROLE_SERVER_ADMIN_VIEW",
    //Заводить, править и удалять серверы и источники. Проверяется по ЧЕЛОВЕКУ, как раздача прав.
    "ROLE_SERVER_MANAGE",
] as const;

export type Permission = typeof PERMISSIONS[number];

export const ROLE_GROUPS = [
    "ROLE_SERVER_USER",
    "ROLE_PLAYER_USER",
    "ROLE_USER_ADMIN",
    "ROLE_SERVER_ADMIN",
    "ROLE_ROOT",
] as const;

export type RoleGroup = typeof ROLE_GROUPS[number];

export type Role = Permission | RoleGroup;

//Иерархия. Record: новая группа не скомпилируется, пока ей не дадут состав.
export const ROLE_HIERARCHY: Readonly<Record<RoleGroup, readonly Role[]>> = {
    //Роль по умолчанию: выдаётся при первом /start. То, ради чего бот отдаётся в общее пользование.
    ROLE_SERVER_USER: [
        "ROLE_SERVER_LIST",
        "ROLE_SERVER_SUBSCRIBE",
        "ROLE_SERVER_STATUS",
        "ROLE_SERVER_OBSERVED",
        "ROLE_TS_VIEW",
    ],
    ROLE_PLAYER_USER: [
        "ROLE_SERVER_USER",
        "ROLE_PLAYER_WATCH",
        "ROLE_PLAYER_LIST",
        "ROLE_PLAYER_WHERE",
        "ROLE_PLAYER_HISTORY",
        "ROLE_PLAYER_ALIASES",
        "ROLE_PLAYER_DOSSIER",
    ],
    ROLE_USER_ADMIN: [
        "ROLE_SERVER_USER",
        "ROLE_ACCESS_MANAGE",
    ],
    //Управление списком серверов (итерация 14). Два права, а не одно: смотреть без права менять
    //можно выдать помощнику.
    ROLE_SERVER_ADMIN: [
        "ROLE_SERVER_USER",
        "ROLE_SERVER_ADMIN_VIEW",
        "ROLE_SERVER_MANAGE",
    ],
    ROLE_ROOT: [
        "ROLE_PLAYER_USER",
        "ROLE_USER_ADMIN",
        "ROLE_SERVER_ADMIN",
    ],
};

export const DEFAULT_ROLE: RoleGroup = "ROLE_SERVER_USER";

const ALL_ROLES: ReadonlySet<string> = new Set<string>([...PERMISSIONS, ...ROLE_GROUPS]);

export function isRole(value: string): value is Role {
    return ALL_ROLES.has(value);
}

function isRoleGroup(role: Role): role is RoleGroup {
    return role in ROLE_HIERARCHY;
}

//Иерархия разворачивается ОДИН раз, при загрузке модуля: проверка доступа на каждый апдейт —
//это вхождение в множество, без обхода дерева. Цикл в иерархии роняет старт, а не зацикливает
//первую же проверку.
function expandAll(): ReadonlyMap<Role, ReadonlySet<Permission>> {
    const expanded = new Map<Role, ReadonlySet<Permission>>();

    const expand = (role: Role, path: readonly Role[]): ReadonlySet<Permission> => {
        const known = expanded.get(role);

        if (known) {
            return known;
        }

        if (path.includes(role)) {
            throw new Error(`Цикл в иерархии ролей: ${[...path, role].join(" -> ")}`);
        }

        const permissions = new Set<Permission>();

        if (isRoleGroup(role)) {
            for (const child of ROLE_HIERARCHY[role]) {
                for (const permission of expand(child, [...path, role])) {
                    permissions.add(permission);
                }
            }
        } else {
            permissions.add(role);
        }

        expanded.set(role, permissions);

        return permissions;
    };

    for (const role of ALL_ROLES) {
        expand(role as Role, []);
    }

    return expanded;
}

const EXPANDED = expandAll();

//Плоский набор прав, который даёт роль, со всем унаследованным.
export function permissionsOfRole(role: Role): ReadonlySet<Permission> {
    return EXPANDED.get(role) ?? new Set();
}

//Права чата по его ролям. ROLE_ANONYMOUS добавляется всегда: состояния «прав нет вовсе»
//не существует.
export function permissionsOfRoles(roles: Iterable<Role>): ReadonlySet<Permission> {
    const permissions = new Set<Permission>(["ROLE_ANONYMOUS"]);

    for (const role of roles) {
        for (const permission of permissionsOfRole(role)) {
            permissions.add(permission);
        }
    }

    return permissions;
}

//Права чата, которому никто ничего не менял: аноним плюс роль по умолчанию. Под них
//публикуется общее меню команд.
export const DEFAULT_PERMISSIONS: ReadonlySet<Permission> = permissionsOfRoles([DEFAULT_ROLE]);

//Почему выдать или отозвать нельзя. undefined — можно.
export type ManageRefusal =
    //ROLE_ROOT задаётся только TELEGRAM_ROOT_CHAT_IDS: через бота его не выдать и не отнять.
    | "rootOnlyFromConfig"
    //ROLE_ANONYMOUS есть у всех и так.
    | "implicit"
    | "noAccessManage"
    //Роль даёт право раздавать права — это только root, иначе любой админ плодил бы админов.
    | "adminOnlyByRoot"
    //Выдать можно только то, что есть у тебя самого.
    | "exceedsOwn";

//Одно правило на выдачу и на отзыв: отобрать можно ровно то, что ты мог бы выдать.
//Иначе админ без прав на игроков снимал бы их с тех, кому их дал root.
export function manageRefusal(
    actor: ReadonlySet<Permission>,
    actorIsRoot: boolean,
    role: Role,
): ManageRefusal | undefined {
    if (role === "ROLE_ROOT") {
        return "rootOnlyFromConfig";
    }

    if (role === "ROLE_ANONYMOUS") {
        return "implicit";
    }

    if (!actor.has("ROLE_ACCESS_MANAGE")) {
        return "noAccessManage";
    }

    const granted = permissionsOfRole(role);

    if (granted.has("ROLE_ACCESS_MANAGE") && !actorIsRoot) {
        return "adminOnlyByRoot";
    }

    for (const permission of granted) {
        if (!actor.has(permission)) {
            return "exceedsOwn";
        }
    }

    return undefined;
}

//Человек пишет роль как удобно: player_user, ROLE_PLAYER_USER, Role_Player_User.
export function parseRole(raw: string): Role | undefined {
    const upper = raw.trim().toUpperCase();
    const candidate = upper.startsWith("ROLE_") ? upper : `ROLE_${upper}`;

    return isRole(candidate) ? candidate : undefined;
}
