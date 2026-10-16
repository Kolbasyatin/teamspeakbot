import test from "node:test";
import assert from "node:assert/strict";
import type {AdminServer, AdminSource} from "../servers/ServerAdminModel.js";
import {
    ADMIN_MANAGE_PATTERN,
    ADMIN_VIEW_PATTERN,
    CATALOG_START,
    cardReadiness,
    decodeAdminButton,
    describeParams,
    encodeAdminButton,
    readinessIcon,
    readinessMark,
    renderAdminCard,
    renderDeleteConfirm,
} from "./ServerAdminMessages.js";
import {decodeAction} from "./ServerListMessage.js";

function source(overrides: Partial<AdminSource> = {}): AdminSource {
    const config = {type: "a2s", host: "37.48.253.41", port: 17771, timeout: 5000} as const;

    return {
        id: 34,
        serverId: 14,
        role: "primary",
        priority: 0,
        enabled: true,
        queryType: "a2s",
        raw: {...config},
        config,
        problem: undefined,
        ...overrides,
    };
}

function server(overrides: Partial<AdminServer> = {}): AdminServer {
    return {
        id: 14,
        name: "Test <b>",
        gameAddress: "37.48.253.41:2001",
        enabled: true,
        listPosition: undefined,
        subscriberCount: 3,
        sources: [source()],
        ...overrides,
    };
}

function buttonData(keyboard: ReturnType<typeof renderAdminCard>["keyboard"]): string[] {
    return keyboard.inline_keyboard.flat().map(button => "callback_data" in button ? button.callback_data : "");
}

test("кнопка кодируется и разбирается обратно вместе с происхождением", () => {
    const button = {action: "sourceDelete", id: 34, origin: {view: "catalog", page: 2, search: "arma"}} as const;

    assert.deepEqual(decodeAdminButton(encodeAdminButton(button)), button);
    assert.equal(decodeAdminButton("a:zz:1:c:0:"), undefined);
    assert.equal(decodeAdminButton("k:s:1:c:0:"), undefined);
});

test("кнопки просмотра и правки ловятся разными шаблонами — у них разные права", () => {
    const view = encodeAdminButton({action: "check", id: 1, origin: CATALOG_START});
    const manage = encodeAdminButton({action: "deleteConfirm", id: 1, origin: CATALOG_START});

    assert.ok(ADMIN_VIEW_PATTERN.test(view) && !ADMIN_MANAGE_PATTERN.test(view));
    assert.ok(ADMIN_MANAGE_PATTERN.test(manage) && !ADMIN_VIEW_PATTERN.test(manage));
    //Кнопки источника (se, sd, sx) не должны попадать в просмотр через общий префикс.
    assert.ok(!ADMIN_VIEW_PATTERN.test(encodeAdminButton({action: "sourceOff", id: 1, origin: CATALOG_START})));
});

test("карточка показывает id, источники с конфигом и экранирует имя", () => {
    const {text} = renderAdminCard(server(), CATALOG_START);

    assert.match(text, /#14 Test &lt;b&gt;/);
    assert.match(text, /подписчиков: 3/);
    assert.match(text, /#34 a2s · primary · prio 0 · вкл/);
    assert.match(text, /host=37\.48\.253\.41 port=17771 timeout=5000/);
    assert.match(text, /🟢 готов/);
});

test("непригодный источник показан с причиной и за готовность не считается", () => {
    const broken = server({sources: [source({config: undefined, problem: "port: нужно целое число"})]});
    const {text} = renderAdminCard(broken, CATALOG_START);

    assert.match(text, /⚠️ непригоден: port: нужно целое число/);
    assert.equal(cardReadiness(broken), "noSources");
    assert.match(text, /включён, но опрашивать нечем/);
});

test("черновик подписан черновиком", () => {
    assert.equal(readinessMark("noSources", false), "📝 черновик: нет источников");
    assert.match(renderAdminCard(server({enabled: false, sources: []}), CATALOG_START).text, /черновик/);
});

test("кнопки карточки: переключатель сервера, по паре на источник, подписка, удаление и возврат в список", () => {
    const origin = {view: "catalog", page: 1, search: "arma"} as const;
    const data = buttonData(renderAdminCard(server(), origin).keyboard);

    assert.deepEqual(data.slice(0, 4).map(item => decodeAdminButton(item)?.action), [
        "serverOff", "check", "sourceOff", "sourceDelete",
    ]);
    //«Подписка» — обычная карточка подписчика: администратор тоже подписывается, а из админского
    //списка нажатие ведёт сюда.
    assert.deepEqual(decodeAction(data[4] ?? ""), {...origin, action: "open", serverId: 14});
    assert.equal(decodeAdminButton(data[5] ?? "")?.action, "deleteAsk");
    //«К списку» — обычная кнопка списка: её обрабатывает список, а не админка.
    assert.deepEqual(decodeAction(data[6] ?? ""), {...origin, action: "page", serverId: 0});
});

test("подтверждение удаления называет число подписчиков", () => {
    const {text, keyboard} = renderDeleteConfirm(server(), CATALOG_START);

    assert.match(text, /Подписчиков: 3 — их подписки удалятся/);
    assert.deepEqual(buttonData(keyboard).map(item => decodeAdminButton(item)?.action), ["deleteConfirm", "open"]);
});

test("параметры показаны так, как их вводят", () => {
    assert.equal(
        describeParams({type: "rest", url: "https://e.com", timeout: 1, fields: {players: "data.online"}}),
        "url=https://e.com timeout=1 fields.players=data.online",
    );
});

test("значок готовности: черновик и поломка различаются", () => {
    assert.equal(readinessIcon("noSources", false), "📝");
    assert.equal(readinessIcon("noSources", true), "⚠️");
    assert.equal(readinessIcon("ready", true), "🟢");
});

test("карточка показывает позицию в списке", () => {
    assert.match(renderAdminCard(server({listPosition: 1}), CATALOG_START).text, /📌 Позиция в списке: 1/);
    assert.match(renderAdminCard(server(), CATALOG_START).text, /Позиция в списке: нет/);
});
