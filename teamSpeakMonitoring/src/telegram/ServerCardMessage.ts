import {InlineKeyboard} from "grammy";
import type {CatalogServer} from "../catalog/CatalogServer.js";
import {
    SUBSCRIPTION_EVENT_TITLES,
    isSubscriptionEventKind,
    type SubscriptionEventKind,
} from "./SubscriptionEvent.js";
import {decodeOrigin, encodeOrigin, type ListOrigin} from "./ServerListMessage.js";
import {escapeHtml} from "./escapeHtml.js";

//Карточка одного сервера: всё, что можно с ним сделать, — подписаться или отписаться, проверить,
//что на нём сейчас, настроить, что присылать.
//
//Отдельный экран, а не кнопки прямо в списке: в списке на сервер одна кнопка, иначе при паре
//десятков серверов он превращается в стену. Всё многообразие действий живёт там, где его ищут, —
//внутри своего сервера. Карточка открывается из обоих списков и знает, откуда, чтобы вернуть назад.

export type CardActionType = "toggleEvent" | "subscribe" | "unsubscribe" | "check" | "back";

export interface CardAction {
    action: CardActionType;
    serverId: number;
    //Заполнен только у toggleEvent. Для остальных действий пустая строка.
    kind: SubscriptionEventKind | undefined;
    //Откуда открыли карточку. Носится в каждой кнопке, потому что после любого действия карточка
    //перерисовывается и «◀ К списку» должен по-прежнему знать, куда вести.
    origin: ListOrigin;
}

const CARD_ACTION_CODE: Record<CardActionType, string> = {
    toggleEvent: "e",
    subscribe: "s",
    unsubscribe: "u",
    check: "c",
    back: "b",
};

//Своё пространство кодов, отдельное от списка: у карточки другой набор действий, и мешать их
//в один разбор значит получить те самые ветвления, от которых уходили.
export const CARD_ACTION_PATTERN = new RegExp(
    `^k:[${Object.values(CARD_ACTION_CODE).join("")}]:`,
);

//k:<действие>:<сервер>:<тип>:<список>:<страница>:<поиск> — семь частей. Хвост из трёх частей —
//тот же формат происхождения, что у кнопок списка, поэтому кодируется его функцией.
export function encodeCardAction(action: CardAction): string {
    return [
        "k",
        CARD_ACTION_CODE[action.action],
        action.serverId,
        action.kind ?? "",
        ...encodeOrigin(action.origin),
    ].join(":");
}

//undefined вместо исключения: кнопка может прийти из сообщения, отправленного до смены формата.
export function decodeCardAction(data: string): CardAction | undefined {
    const parts = data.split(":");

    if (parts.length !== 7 || parts[0] !== "k") {
        return undefined;
    }

    const [, code, serverId, kind, view, page, search] = parts;
    const action = (Object.keys(CARD_ACTION_CODE) as CardActionType[])
        .find(name => CARD_ACTION_CODE[name] === code);
    const origin = decodeOrigin(view, page, search);

    if (!action || !origin || serverId === undefined || !/^\d+$/.test(serverId)) {
        return undefined;
    }

    return {
        action,
        serverId: Number(serverId),
        kind: kind !== undefined && isSubscriptionEventKind(kind) ? kind : undefined,
        origin,
    };
}

export function renderServerCard(
    server: CatalogServer,
    subscribed: boolean,
    enabled: ReadonlySet<SubscriptionEventKind>,
    origin: ListOrigin,
): {text: string; keyboard: InlineKeyboard} {
    const keyboard = new InlineKeyboard();
    const button = (action: CardActionType, kind?: SubscriptionEventKind): string =>
        encodeCardAction({action, serverId: server.id, kind, origin});

    if (subscribed) {
        //Строки берутся из той же таблицы, что и сами типы: второго списка, который может разъехаться
        //с первым, не появляется. Добавили тип — кнопка возникает сама.
        for (const kind of Object.keys(SUBSCRIPTION_EVENT_TITLES) as SubscriptionEventKind[]) {
            keyboard
                .text(`${enabled.has(kind) ? "✅" : "▫️"} ${SUBSCRIPTION_EVENT_TITLES[kind]}`, button("toggleEvent", kind))
                .row();
        }
    } else {
        keyboard.text("➕ Подписаться", button("subscribe")).row();
    }

    //Проверка не зависит от подписки — ради этого карточка и открывается из каталога.
    keyboard.text("🔍 Проверить", button("check")).row();

    if (subscribed) {
        keyboard.text("🗑 Отписаться", button("unsubscribe"));
    }

    keyboard.text("◀ К списку", button("back"));

    return {
        text: [
            `<b>${escapeHtml(server.name)}</b>`,
            `<code>${escapeHtml(server.gameAddress)}</code>`,
            "",
            describeSubscription(subscribed, enabled),
        ].join("\n"),
        keyboard,
    };
}

function describeSubscription(subscribed: boolean, enabled: ReadonlySet<SubscriptionEventKind>): string {
    if (!subscribed) {
        return "Ты не подписан на этот сервер.";
    }

    //Иначе человек видит подписку, которая молчит, и считает это поломкой.
    return enabled.size === 0
        ? "Ничего не присылаю — все уведомления выключены."
        : "Что присылать:";
}
