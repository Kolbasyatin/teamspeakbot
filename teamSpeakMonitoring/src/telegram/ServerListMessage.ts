import {InlineKeyboard} from "grammy";
import type {CatalogServer} from "../catalog/CatalogServer.js";

//Сборка сообщения со списком серверов: текст и клавиатура. Живёт отдельно от бота, потому что
//это чистая функция от данных — её видно в тестах целиком, без grammy, без сети и без БД.
//
//Разметка здесь телеграмная и такой и остаётся: по решению §5.4 общими будут ДАННЫЕ, а как они
//выглядят — дело транспорта.

//Сколько серверов на странице. Восемь — чтобы клавиатура помещалась на экран телефона целиком
//вместе со стрелками.
export const PAGE_SIZE = 8;

//Два списка, которые рисуются одинаково и отличаются только источником строк и подписью:
//catalog — «на что можно подписаться», mine — «на что я уже подписан».
export type ListView = "catalog" | "mine";

//toggle — переключить подписку на serverId, page — перелистнуть, open — открыть карточку сервера.
export type ListActionType = "toggle" | "page" | "open";

//Что пользователь нажал. Клавиатура и её разбор — две стороны одного протокола, поэтому лежат рядом:
//поменяешь формат в одном месте — второе перестанет компилироваться вместе с ним.
export interface ListAction {
    view: ListView;
    action: ListActionType;
    serverId: number;
    page: number;
    search: string;
}

//Коды в callback_data. Record, а не пара тернарников при разборе: компилятор требует запись
//для КАЖДОГО варианта, поэтому добавление третьего действия валит сборку, пока ему не дадут код.
//Тернарник «если не toggle, значит page» этого не умеет — забытое действие молча стало бы page.
//Одна таблица на обе стороны: encode читает её слева направо, decode справа налево,
//и разъехаться им негде.
const VIEW_CODE: Record<ListView, string> = {catalog: "c", mine: "m"};
const ACTION_CODE: Record<ListActionType, string> = {toggle: "t", page: "p", open: "o"};

//Что делает нажатие на сервер — зависит от списка, и это тоже таблица, а не тернарник:
//добавится третий список, компилятор потребует решить, как он себя ведёт.
//В каталоге нажатие означает «слежу / не слежу» — быстрый путь, ломать его нельзя.
//В своих подписках сервер уже выбран, поэтому нажатие открывает его настройки.
const SERVER_BUTTON_ACTION: Record<ListView, ListActionType> = {catalog: "toggle", mine: "open"};

//По чему бот узнаёт свою кнопку среди чужих. Собирается из тех же таблиц, а не пишется руками:
//иначе новый код действия пришлось бы вписывать в два места, и забытое второе означало бы
//кнопку, которую никто не обрабатывает.
//Проверяет только начало — полный разбор делает decodeAction.
export const LIST_ACTION_PATTERN = new RegExp(
    `^[${Object.values(VIEW_CODE).join("")}]:[${Object.values(ACTION_CODE).join("")}]:`,
);

export interface ServerListPage {
    view: ListView;
    servers: CatalogServer[];
    //Множество id, на которые чат уже подписан: по нему ставится галочка.
    subscribed: ReadonlySet<number>;
    page: number;
    total: number;
    search: string;
}

//Поисковая строка приходит от человека и уезжает и в SQL LIKE, и в callback_data.
//Отсюда три изъятия сразу: % и _ — подстановочные знаки LIKE, двоеточие — разделитель
//в callback_data. Обрезка — потому что у callback_data всего 64 байта на всё.
export function sanitizeSearch(raw: string): string {
    return raw.replace(/[:%_\\]/g, " ").trim().slice(0, 24);
}

export function pageCount(total: number): number {
    return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

export function encodeAction(action: ListAction): string {
    return [
        VIEW_CODE[action.view],
        ACTION_CODE[action.action],
        action.serverId,
        action.page,
        action.search,
    ].join(":");
}

//undefined, а не исключение: callback_data может прийти из старого сообщения после обновления
//формата, и это не повод ронять обработчик. Неизвестный код действия отсеивается тем же способом,
//что и мусор, — по отсутствию в таблице, а не отдельной проверкой, которую можно забыть дописать.
export function decodeAction(data: string): ListAction | undefined {
    const parts = data.split(":");

    if (parts.length !== 5) {
        return undefined;
    }

    const [view, action, serverId, page, search] = parts;
    const decodedView = decodeByCode(VIEW_CODE, view);
    const decodedAction = decodeByCode(ACTION_CODE, action);

    if (!decodedView || !decodedAction) {
        return undefined;
    }

    if (!isNonNegativeInteger(serverId) || !isNonNegativeInteger(page)) {
        return undefined;
    }

    return {
        view: decodedView,
        action: decodedAction,
        serverId: Number(serverId),
        page: Number(page),
        search: search ?? "",
    };
}

//Обратный поиск по той же таблице: код → значение. Отдельной таблицы для разбора нет намеренно —
//две таблицы рано или поздно разъезжаются.
function decodeByCode<TValue extends string>(
    table: Record<TValue, string>,
    code: string | undefined,
): TValue | undefined {
    return (Object.keys(table) as TValue[]).find(value => table[value] === code);
}

export function renderServerList(page: ServerListPage): {text: string; keyboard: InlineKeyboard} {
    return {
        text: renderText(page),
        keyboard: renderKeyboard(page),
    };
}

function renderText(page: ServerListPage): string {
    if (page.total === 0) {
        return page.view === "catalog"
            ? emptyCatalogText(page.search)
            : "Ты пока ни на что не подписан. Открой /serverlist и выбери серверы.";
    }

    const title = page.view === "catalog"
        ? `Каталог серверов: ${page.total}`
        : `Твои подписки: ${page.total}`;

    const lines = [page.search === "" ? title : `${title} по запросу «${page.search}»`];
    const pages = pageCount(page.total);

    if (pages > 1) {
        lines.push(`Страница ${page.page + 1} из ${pages}`);
    }

    lines.push("");
    //Подсказка обязана совпадать с тем, что реально делает нажатие: в каталоге это «слежу /
    //не слежу», в своих подписках — карточка сервера. Иначе человек не узнает про настройки,
    //пока случайно не нажмёт.
    lines.push(page.view === "catalog"
        ? "Нажми на сервер, чтобы начать или перестать следить.\nЧто именно присылать — настраивается в /my."
        : "Нажми на сервер — настроить уведомления или отписаться.");

    return lines.join("\n");
}

function emptyCatalogText(search: string): string {
    return search === ""
        ? "Каталог пуст — серверы ещё не заведены."
        : `Ничего не найдено по запросу «${search}».`;
}

function renderKeyboard(page: ServerListPage): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    for (const server of page.servers) {
        const mark = page.subscribed.has(server.id) ? "✅" : "➕";

        keyboard
            .text(`${mark} ${server.name}`, encodeAction({
                view: page.view,
                action: SERVER_BUTTON_ACTION[page.view],
                serverId: server.id,
                page: page.page,
                search: page.search,
            }))
            .row();
    }

    const pages = pageCount(page.total);

    //Стрелки только туда, куда есть куда идти: кнопка, которая ничего не делает, выглядит поломкой.
    //Номер страницы живёт в тексте, а не кнопкой-заглушкой — по той же причине.
    if (page.page > 0) {
        keyboard.text("◀ Назад", encodeAction({
            view: page.view,
            action: "page",
            serverId: 0,
            page: page.page - 1,
            search: page.search,
        }));
    }

    if (page.page + 1 < pages) {
        keyboard.text("Вперёд ▶", encodeAction({
            view: page.view,
            action: "page",
            serverId: 0,
            page: page.page + 1,
            search: page.search,
        }));
    }

    return keyboard;
}

function isNonNegativeInteger(value: string | undefined): boolean {
    return value !== undefined && /^\d+$/.test(value);
}
