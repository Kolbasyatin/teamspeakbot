import test from "node:test";
import assert from "node:assert/strict";
import {
    decodeAction,
    decodeOrigin,
    encodeAction,
    encodeOrigin,
    PAGE_SIZE,
    renderServerList,
    sanitizeSearch,
    type ListAction,
    type ListOrigin,
    type ServerListPage,
} from "./ServerListMessage.js";
import type {CatalogServer} from "../catalog/CatalogServer.js";

function server(id: number, name: string): CatalogServer {
    return {id, name, gameAddress: `127.0.0.1:${2000 + id}`};
}

function page(overrides: Partial<ServerListPage> = {}): ServerListPage {
    return {
        view: "catalog",
        servers: [server(1, "Первый"), server(2, "Второй")],
        subscribed: new Set<number>(),
        page: 0,
        total: 2,
        search: "",
        ...overrides,
    };
}

//Кнопки клавиатуры плоским списком [текст, callback_data] — так их удобно сверять целиком.
function buttons(keyboard: {inline_keyboard: {text: string; callback_data?: string}[][]}): [string, string][] {
    return keyboard.inline_keyboard.flat().map(button => [button.text, button.callback_data ?? ""]);
}

test("действие переживает кодирование и разбор", () => {
    const action: ListAction = {view: "mine", action: "open", serverId: 42, page: 3, search: "arma"};

    assert.deepEqual(decodeAction(encodeAction(action)), action);
});

test("испорченная callback_data не разбирается, а не роняет обработчик", () => {
    //Кнопка из сообщения, отправленного до смены формата, — обычное дело после выката.
    assert.equal(decodeAction("мусор"), undefined);
    assert.equal(decodeAction("c:o:1:0"), undefined);
    assert.equal(decodeAction("x:o:1:0:"), undefined);
    assert.equal(decodeAction("c:o:абв:0:"), undefined);
    //toggle был действием списка до переезда подписки в карточку — старые кнопки должны устареть,
    //а не молча превратиться в другое действие.
    assert.equal(decodeAction("c:t:1:0:"), undefined);
});

test("из поиска вычищаются подстановочные знаки LIKE и разделитель callback_data", () => {
    //% и _ иначе стали бы шаблоном в SQL, двоеточие развалило бы разбор кнопки.
    assert.equal(sanitizeSearch("  a%b_c:d  "), "a b c d");
});

test("поиск обрезается: в callback_data всего 64 байта на всё", () => {
    assert.equal(sanitizeSearch("a".repeat(100)).length, 24);
});

test("подписанный сервер помечен галочкой, остальные — пустым квадратом", () => {
    const {keyboard} = renderServerList(page({subscribed: new Set([2])}));

    assert.deepEqual(buttons(keyboard).map(([text]) => text), ["▫️ Первый", "✅ Второй"]);
});

test("на сервер ровно одна кнопка, и она открывает карточку в любом списке", () => {
    //Подписка и проверка живут в карточке: две кнопки в строке делили бы ширину поровну
    //и обрезали имя, а вторая строка на сервер удваивала бы высоту списка.
    for (const view of ["catalog", "mine"] as const) {
        const {keyboard} = renderServerList(page({view}));

        //grammy оставляет пустую строку после последнего .row() — она не рисуется, и считать её не надо.
        const rows = keyboard.inline_keyboard.filter(row => row.length > 0);

        assert.deepEqual(rows.map(row => row.length), [1, 1], "по одной кнопке на сервер, без стрелок");
        assert.equal(decodeAction(buttons(keyboard)[0]?.[1] ?? "")?.action, "open");
    }
});

test("нажатие на сервер несёт текущую страницу и поиск", () => {
    //Карточка запоминает это как происхождение: «◀ К списку» вернёт на ту же страницу с тем же поиском.
    const {keyboard} = renderServerList(page({page: 2, total: 40, search: "arma"}));

    assert.equal(buttons(keyboard)[0]?.[1], "c:o:1:2:arma");
});

test("происхождение переживает кодирование и разбор", () => {
    const origin: ListOrigin = {view: "catalog", page: 4, search: "arma"};

    assert.deepEqual(decodeOrigin(...encodeOrigin(origin)), origin);
    assert.equal(decodeOrigin("x", "0", ""), undefined);
    assert.equal(decodeOrigin("c", "-1", ""), undefined);
});

test("стрелки появляются только туда, куда есть куда идти", () => {
    const single = renderServerList(page({total: 2}));
    assert.deepEqual(buttons(single.keyboard).map(([text]) => text).filter(isNav), []);

    const first = renderServerList(page({page: 0, total: 3 * PAGE_SIZE}));
    assert.deepEqual(buttons(first.keyboard).map(([text]) => text).filter(isNav), ["Вперёд ▶"]);

    const middle = renderServerList(page({page: 1, total: 3 * PAGE_SIZE}));
    assert.deepEqual(buttons(middle.keyboard).map(([text]) => text).filter(isNav), ["◀ Назад", "Вперёд ▶"]);

    const last = renderServerList(page({page: 2, total: 3 * PAGE_SIZE}));
    assert.deepEqual(buttons(last.keyboard).map(([text]) => text).filter(isNav), ["◀ Назад"]);
});

test("номер страницы показывается только когда страниц несколько", () => {
    assert.ok(!renderServerList(page({total: 2})).text.includes("Страница"));
    assert.ok(renderServerList(page({page: 1, total: 3 * PAGE_SIZE})).text.includes("Страница 2 из 3"));
});

test("пустой каталог и пустой поиск объясняются по-разному", () => {
    assert.match(renderServerList(page({servers: [], total: 0})).text, /Каталог пуст/);
    assert.match(renderServerList(page({servers: [], total: 0, search: "arma"})).text, /Ничего не найдено/);
});

test("пустой список подписок зовёт в каталог", () => {
    const {text} = renderServerList(page({view: "mine", servers: [], total: 0}));

    assert.match(text, /\/serverlist/);
});

function isNav(text: string): boolean {
    return text.includes("◀") || text.includes("▶");
}
