import {InlineKeyboard} from "grammy";
import type {CatalogServer} from "../catalog/CatalogServer.js";

//Сборка сообщения со списком серверов: текст и клавиатура. Живёт отдельно от бота, потому что
//это чистая функция от данных — её видно в тестах целиком, без grammy, без сети и без БД.
//
//Разметка здесь телеграмная и такой и остаётся: по решению §5.4 общими будут ДАННЫЕ, а как они
//выглядят — дело транспорта.

//Сколько серверов на странице. Восемь — чтобы клавиатура помещалась на экран телефона целиком
//вместе со стрелками. На сервер ровно одна кнопка: всё остальное живёт в карточке, иначе
//при паре десятков серверов список превращается в стену кнопок.
export const PAGE_SIZE = 8;

//Два списка, которые рисуются одинаково и отличаются только источником строк и подписью:
//catalog — «на что можно подписаться», mine — «на что я уже подписан».
export type ListView = "catalog" | "mine";

//page — перелистнуть, open — открыть карточку сервера. Подписка, проверка и настройки живут
//в карточке: нажатие на имя в любом списке ведёт туда. Раньше в каталоге нажатие переключало
//подписку напрямую, но тогда для второго действия (проверить) в строке не оставалось места —
//Telegram делит строку между кнопками поровну, и имя обрезалось наполовину.
export type ListActionType = "page" | "open";

//Откуда открыли карточку: какой список, страница, поиск. Карточка носит это в своих кнопках,
//чтобы «◀ К списку» вернул ровно туда, откуда пришли, а не на первую страницу.
export interface ListOrigin {
    view: ListView;
    page: number;
    search: string;
}

//Что пользователь нажал. Клавиатура и её разбор — две стороны одного протокола, поэтому лежат рядом:
//поменяешь формат в одном месте — второе перестанет компилироваться вместе с ним.
export interface ListAction extends ListOrigin {
    action: ListActionType;
    serverId: number;
}

//Коды в callback_data. Record, а не пара тернарников при разборе: компилятор требует запись
//для КАЖДОГО варианта, поэтому добавление действия валит сборку, пока ему не дадут код.
//Тернарник «если не page, значит open» этого не умеет — забытое действие молча стало бы open.
//Одна таблица на обе стороны: encode читает её слева направо, decode справа налево,
//и разъехаться им негде.
const VIEW_CODE: Record<ListView, string> = {catalog: "c", mine: "m"};
const ACTION_CODE: Record<ListActionType, string> = {page: "p", open: "o"};

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

//<список>:<действие>:<сервер>:<страница>:<поиск>. Код списка стоит первым, а не в хвосте вместе
//с остальным происхождением: по нему и по действию LIST_ACTION_PATTERN узнаёт кнопку списка.
export function encodeAction(action: ListAction): string {
    const [view, page, search] = encodeOrigin(action);

    return [view, ACTION_CODE[action.action], action.serverId, page, search].join(":");
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
    const decodedAction = decodeByCode(ACTION_CODE, action);
    const origin = decodeOrigin(view, page, search);

    if (!decodedAction || !origin || !isNonNegativeInteger(serverId)) {
        return undefined;
    }

    return {
        ...origin,
        action: decodedAction,
        serverId: Number(serverId),
    };
}

//Происхождение в виде частей callback_data: код списка, страница, поиск. Общее для кнопок списка
//и карточки — карточка дописывает эти три части в хвост своих, чтобы уметь вернуться.
export function encodeOrigin(origin: ListOrigin): [string, string, string] {
    return [VIEW_CODE[origin.view], String(origin.page), origin.search];
}

export function decodeOrigin(
    view: string | undefined,
    page: string | undefined,
    search: string | undefined,
): ListOrigin | undefined {
    const decodedView = decodeByCode(VIEW_CODE, view);

    if (!decodedView || !isNonNegativeInteger(page)) {
        return undefined;
    }

    return {view: decodedView, page: Number(page), search: search ?? ""};
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
    //Подсказка обязана совпадать с тем, что реально делает нажатие. В обоих списках это карточка,
    //разница только в том, что в ней человек скорее всего ищет.
    lines.push(page.view === "catalog"
        ? "Нажми на сервер — подписаться или посмотреть, что на нём сейчас."
        : "Нажми на сервер — настроить уведомления, проверить или отписаться.");

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
        //Галочка — подписан. Пустой квадрат, а не плюс: нажатие открывает карточку, а не подписывает,
        //и плюс обещал бы не то.
        const mark = page.subscribed.has(server.id) ? "✅" : "▫️";

        keyboard
            .text(`${mark} ${server.name}`, encodeAction({
                view: page.view,
                action: "open",
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
