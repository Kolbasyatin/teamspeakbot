import type {Permission} from "../access/Roles.js";
import {CARD_ACTION_PATTERN} from "./ServerCardMessage.js";
import {ADMIN_MANAGE_PATTERN, ADMIN_VIEW_PATTERN} from "./ServerAdminMessages.js";
import {LIST_ACTION_PATTERN} from "./ServerListMessage.js";
import {STATUS_REFRESH} from "./ServerStatusMessage.js";
import {
    PLAYER_CARD_PATTERN,
    PLAYER_HISTORY_PATTERN,
    PLAYER_INFO_PATTERN,
    PLAYER_PICK_PATTERN,
    PLAYER_WAIT_PATTERN,
} from "./PlayerMessages.js";

//Что требует каждая команда и каждая кнопка. Одна таблица на весь бот, а не по наборам:
//права читаются целиком в одном месте, как и написано в rbac.md.
//
//Карта обязана быть ИСЧЕРПЫВАЮЩЕЙ. Команда, которой здесь нет, страж считает запрещённой,
//а тест (commandAccess.test.ts) сверяет карту с тем, что наборы реально регистрируют, и падает
//при расхождении в любую сторону.
export const COMMAND_ACCESS: Readonly<Record<string, Permission>> = {
    start: "ROLE_ANONYMOUS",
    help: "ROLE_ANONYMOUS",
    whoami: "ROLE_ANONYMOUS",
    //Обратная связь — всем, даже без ролей: у кого роль отобрали, должен иметь возможность попросить
    //её назад. От засыпания защищает частота. /reply открыт по той же карте, а пускает его сам
    //обработчик: ответить можно только на доставленное в этот чат сообщение (FeedbackCommands).
    message: "ROLE_ANONYMOUS",
    reply: "ROLE_ANONYMOUS",

    serverlist: "ROLE_SERVER_LIST",
    my: "ROLE_SERVER_SUBSCRIBE",
    status: "ROLE_SERVER_STATUS",
    //Синоним /status — то же право, иначе запрет обходился бы старым именем.
    time: "ROLE_SERVER_STATUS",
    observed: "ROLE_SERVER_OBSERVED",
    who: "ROLE_TS_VIEW",

    watch: "ROLE_PLAYER_WATCH",
    wait: "ROLE_PLAYER_WATCH",
    unwatch: "ROLE_PLAYER_WATCH",
    players: "ROLE_PLAYER_LIST",
    where: "ROLE_PLAYER_WHERE",
    history: "ROLE_PLAYER_HISTORY",
    aliases: "ROLE_PLAYER_ALIASES",
    playerinfo: "ROLE_PLAYER_DOSSIER",
    steaminfo: "ROLE_PLAYER_DOSSIER",

    grant: "ROLE_ACCESS_MANAGE",
    revoke: "ROLE_ACCESS_MANAGE",
    roles: "ROLE_ACCESS_MANAGE",

    //Карточка — просмотр (по чату), всё остальное — правка (по человеку).
    server: "ROLE_SERVER_ADMIN_VIEW",
    server_add: "ROLE_SERVER_MANAGE",
    server_edit: "ROLE_SERVER_MANAGE",
    server_delete: "ROLE_SERVER_MANAGE",
    source_add: "ROLE_SERVER_MANAGE",
    source_edit: "ROLE_SERVER_MANAGE",
    source_delete: "ROLE_SERVER_MANAGE",
};

//Кнопки — те же шаблоны, по которым их ловят наборы: шаблон один, разъехаться нечему.
//Кнопка получает право той команды, к которой ведёт. Иначе запрет команды обходится нажатием
//кнопки из сообщения, отправленного до отзыва прав.
export interface CallbackAccessRule {
    match: string | RegExp;
    permission: Permission;
}

export const CALLBACK_ACCESS: readonly CallbackAccessRule[] = [
    {match: STATUS_REFRESH, permission: "ROLE_SERVER_STATUS"},
    //Листать и открывать карточку — просмотр каталога. Кнопки «моего» списка (m:) приходят
    //из /my и ведут туда же, в карточку; всё, что меняет подписку, — действия карточки ниже.
    {match: LIST_ACTION_PATTERN, permission: "ROLE_SERVER_LIST"},
    //Подписка, отписка, галочки уведомлений и «🔍 Проверить».
    {match: CARD_ACTION_PATTERN, permission: "ROLE_SERVER_SUBSCRIBE"},
    {match: PLAYER_PICK_PATTERN, permission: "ROLE_PLAYER_WATCH"},
    {match: PLAYER_WAIT_PATTERN, permission: "ROLE_PLAYER_WATCH"},
    {match: PLAYER_CARD_PATTERN, permission: "ROLE_PLAYER_WHERE"},
    {match: PLAYER_HISTORY_PATTERN, permission: "ROLE_PLAYER_HISTORY"},
    {match: PLAYER_INFO_PATTERN, permission: "ROLE_PLAYER_DOSSIER"},
    //Админская карточка: открыть и проверить — просмотр, вкл/выкл и удаление — правка.
    {match: ADMIN_VIEW_PATTERN, permission: "ROLE_SERVER_ADMIN_VIEW"},
    {match: ADMIN_MANAGE_PATTERN, permission: "ROLE_SERVER_MANAGE"},
];

//Чьи права проверять. Правило «видеть — по чату, менять — по человеку».
//Обычные команды и просмотр — по ЧАТУ: выдал роль группе, ею пользуются все участники, а что
//показывать, зависит от того, кто это прочтёт.
//Раздача прав и управление серверами — по ЧЕЛОВЕКУ: их делает конкретный человек, и root,
//набравший /grant в группе ответом на чужое сообщение, должен быть root и там, а остальные
//участники группы — нет.
//Личные права человека — это права его лички с ботом (user_id равен её chat_id), поэтому
//второго хранилища не нужно. Правило выводится из права, а не из списка команд: новая команда
//раздачи прав не может случайно начать проверяться по чату.
export type AccessSubject = "chat" | "user";

const PERSONAL_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(["ROLE_ACCESS_MANAGE", "ROLE_SERVER_MANAGE"]);

export function accessSubject(permission: Permission): AccessSubject {
    return PERSONAL_PERMISSIONS.has(permission) ? "user" : "chat";
}

export function commandPermission(command: string): Permission | undefined {
    return Object.hasOwn(COMMAND_ACCESS, command) ? COMMAND_ACCESS[command] : undefined;
}

export function callbackPermission(data: string): Permission | undefined {
    const rule = CALLBACK_ACCESS.find(({match}) => typeof match === "string" ? match === data : match.test(data));

    return rule?.permission;
}
