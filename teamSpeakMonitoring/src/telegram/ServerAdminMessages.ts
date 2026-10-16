import {InlineKeyboard} from "grammy";
import {readinessOf, type AdminServer, type AdminSource, type ServerReadiness} from "../servers/ServerAdminModel.js";
import {describeSourceForm} from "../servers/sourceForms.js";
import {QUERY_TYPES} from "../monitoring/validateQueryConfig.js";
import {decodeOrigin, encodeAction, encodeOrigin, type ListOrigin} from "./ServerListMessage.js";
import {escapeHtml} from "./escapeHtml.js";

//Админская карточка сервера и её кнопки. Чистые функции от данных: видно в тестах целиком.
//
//Кнопки двух видов по праву, которое они требуют: просмотр (открыть, проверить) — по правам чата,
//правка (вкл/выкл, удалить) — по правам человека. Поэтому и шаблонов два: страж сопоставляет
//кнопку с правом по шаблону, а одна кнопка не может требовать двух разных прав.

export type AdminViewAction = "open" | "check";
export type AdminManageAction = "serverOn" | "serverOff" | "deleteAsk" | "deleteConfirm" | "sourceOn" | "sourceOff" | "sourceDelete";
export type AdminAction = AdminViewAction | AdminManageAction;

const VIEW_CODE: Record<AdminViewAction, string> = {open: "o", check: "k"};
const MANAGE_CODE: Record<AdminManageAction, string> = {
    serverOn: "e",
    serverOff: "d",
    deleteAsk: "x",
    deleteConfirm: "y",
    sourceOn: "se",
    sourceOff: "sd",
    sourceDelete: "sx",
};
const ACTION_CODE: Record<AdminAction, string> = {...VIEW_CODE, ...MANAGE_CODE};

export const ADMIN_VIEW_PATTERN = new RegExp(`^a:(${Object.values(VIEW_CODE).join("|")}):`);
export const ADMIN_MANAGE_PATTERN = new RegExp(`^a:(${Object.values(MANAGE_CODE).join("|")}):`);

//a:<действие>:<id>:<список>:<страница>:<поиск>. id — сервера или источника, смотря по действию.
//Хвост происхождения тот же, что у кнопок списка: «◀ К списку» возвращает туда, откуда пришли.
export interface AdminButton {
    action: AdminAction;
    id: number;
    origin: ListOrigin;
}

export function encodeAdminButton(button: AdminButton): string {
    return ["a", ACTION_CODE[button.action], button.id, ...encodeOrigin(button.origin)].join(":");
}

export function decodeAdminButton(data: string): AdminButton | undefined {
    const parts = data.split(":");

    if (parts.length !== 6 || parts[0] !== "a") {
        return undefined;
    }

    const [, code, id, view, page, search] = parts;
    const action = (Object.keys(ACTION_CODE) as AdminAction[]).find(name => ACTION_CODE[name] === code);
    const origin = decodeOrigin(view, page, search);

    if (!action || !origin || id === undefined || !/^\d+$/.test(id)) {
        return undefined;
    }

    return {action, id: Number(id), origin};
}

//Откуда открыта карточка, если её открыли командой, а не из списка: возвращаться в начало каталога.
export const CATALOG_START: ListOrigin = {view: "catalog", page: 0, search: ""};

const READINESS_TITLE: Record<ServerReadiness, string> = {
    ready: "🟢 готов",
    disabled: "⏸ выключен",
    noSources: "📝 нет источников",
    noPrimary: "⚠️ нет primary — статус по самому приоритетному",
};

//Значок в строке админского списка — тот же смысл, что у отметки в карточке, одним символом.
export function readinessIcon(readiness: ServerReadiness, enabled: boolean): string {
    const icons: Record<ServerReadiness, string> = {ready: "🟢", disabled: "⏸", noSources: enabled ? "⚠️" : "📝", noPrimary: "⚠️"};

    return icons[readiness];
}

//Отметка готовности. «Нет источников» у включённого сервера — поломка, у выключенного — черновик.
export function readinessMark(readiness: ServerReadiness, enabled: boolean): string {
    if (readiness === "noSources") {
        return enabled ? "⚠️ включён, но опрашивать нечем" : "📝 черновик: нет источников";
    }

    return READINESS_TITLE[readiness];
}

//Готовность по источникам карточки. В отличие от списка (там счётчики из SQL), здесь конфиги
//разобраны, и непригодный источник за «есть источник» не считается.
export function cardReadiness(server: AdminServer): ServerReadiness {
    const usable = server.sources.filter(source => source.enabled && source.config !== undefined);

    return readinessOf({
        enabled: server.enabled,
        enabledSourceCount: usable.length,
        enabledPrimaryCount: usable.filter(source => source.role === "primary").length,
    });
}

export function renderAdminCard(server: AdminServer, origin: ListOrigin): {text: string; keyboard: InlineKeyboard} {
    const button = (action: AdminAction, id: number = server.id): string => encodeAdminButton({action, id, origin});
    const keyboard = new InlineKeyboard()
        .text(server.enabled ? "⏸ Выключить" : "▶️ Включить", button(server.enabled ? "serverOff" : "serverOn"))
        .text("🔍 Проверить", button("check"))
        .row();

    for (const source of server.sources) {
        keyboard
            .text(`${source.enabled ? "⏸" : "▶️"} #${source.id}`, button(source.enabled ? "sourceOff" : "sourceOn", source.id))
            .text(`🗑 #${source.id}`, button("sourceDelete", source.id))
            .row();
    }

    keyboard
        //Администратор тоже подписчик: обычная карточка с подпиской открывается отсюда, потому что
        //из админского списка нажатие ведёт сюда, а не в неё.
        .text("🔔 Подписка", encodeAction({...origin, action: "open", serverId: server.id}))
        .text("🗑 Удалить сервер", button("deleteAsk"))
        .row()
        .text("◀ К списку", encodeAction({...origin, action: "page", serverId: 0}));

    return {
        text: [
            `<b>#${server.id} ${escapeHtml(server.name)}</b>`,
            `<code>${escapeHtml(server.gameAddress)}</code> · ${server.enabled ? "включён" : "выключен"} · подписчиков: ${server.subscriberCount}`,
            server.listPosition === undefined
                ? "Позиция в списке: нет — по имени"
                : `📌 Позиция в списке: ${server.listPosition}`,
            readinessMark(cardReadiness(server), server.enabled),
            "",
            server.sources.length === 0 ? "Источников нет." : "Источники:",
            ...server.sources.map(renderSource),
            "",
            `Править: <code>/server_edit ${server.id} name=… address=… position=N|off</code>`,
            `Источник: <code>/source_add ${server.id} &lt;тип&gt; …</code>, <code>/source_edit &lt;id&gt; …</code>`,
        ].join("\n"),
        keyboard,
    };
}

function renderSource(source: AdminSource): string {
    const head = `#${source.id} ${escapeHtml(source.queryType)} · ${source.role} · prio ${source.priority} · ${source.enabled ? "вкл" : "выкл"}`;
    const details = source.config === undefined
        ? `⚠️ непригоден: ${escapeHtml(source.problem ?? "конфиг не разбирается")}`
        : `<code>${escapeHtml(describeParams(source.config))}</code>`;

    return `${head}\n    ${details}`;
}

//Конфиг в том же виде, в каком его вводят: ключ=значение, карта полей — fields.<поле>=<путь>.
//Так строку из карточки можно поправить и отправить обратно.
export function describeParams(config: object): string {
    const pairs: string[] = [];

    for (const [key, value] of Object.entries(config)) {
        if (key === "type") {
            continue;
        }

        if (typeof value === "object" && value !== null) {
            for (const [field, path] of Object.entries(value)) {
                pairs.push(`${key}.${field}=${String(path)}`);
            }
        } else {
            pairs.push(`${key}=${String(value)}`);
        }
    }

    return pairs.join(" ");
}

export function renderDeleteConfirm(server: AdminServer, origin: ListOrigin): {text: string; keyboard: InlineKeyboard} {
    const warning = server.subscriberCount === 0
        ? "Подписчиков нет."
        : `Подписчиков: ${server.subscriberCount} — их подписки удалятся вместе с сервером.`;

    return {
        text: [
            `Удалить <b>#${server.id} ${escapeHtml(server.name)}</b> вместе с источниками?`,
            warning,
            "Отменить нельзя. Если сервер нужен позже — лучше выключить.",
        ].join("\n"),
        keyboard: new InlineKeyboard()
            .text("🗑 Да, удалить", encodeAdminButton({action: "deleteConfirm", id: server.id, origin}))
            .text("Отмена", encodeAdminButton({action: "open", id: server.id, origin})),
    };
}

export function renderProblems(problems: readonly string[]): string {
    return ["Не получилось:", ...problems.map(problem => `• ${escapeHtml(problem)}`)].join("\n");
}

export const SERVER_ADMIN_HELP = [
    "<b>Управление серверами</b>",
    "",
    "<code>/server_add Имя | host:port</code> — новый сервер (черновик, выключен)",
    "<code>/server &lt;id&gt;</code> — карточка: источники, вкл/выкл, удаление",
    "<code>/server_edit &lt;id&gt; name=… address=… enabled=on|off position=N|off</code>",
    "position — место в верху всех списков: 1 — самый верх; off — снять, сервер пойдёт по имени",
    "<code>/server_delete &lt;id&gt;</code> — с подтверждением",
    "",
    "<code>/source_add &lt;id сервера&gt; &lt;тип&gt; параметры…</code>",
    "<code>/source_edit &lt;id источника&gt; параметры…</code>",
    "<code>/source_delete &lt;id источника&gt;</code>",
    "Общие параметры: role=primary|secondary, priority=N (меньше — важнее), enabled=on|off",
    ...QUERY_TYPES.map(type => `${type}: ${escapeHtml(describeSourceForm(type))}`),
    "",
    "Пример: <code>/source_add 14 a2s port=17771</code> — хост и таймаут подставятся сами.",
    "id видно в /serverlist.",
].join("\n");
