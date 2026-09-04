import {InlineKeyboard} from "grammy";
import type {CatalogServer} from "../catalog/CatalogServer.js";
import {
    SUBSCRIPTION_EVENT_TITLES,
    isSubscriptionEventKind,
    type SubscriptionEventKind,
} from "./SubscriptionEvent.js";
import {escapeHtml} from "./escapeHtml.js";

//Карточка одного сервера: что про него присылать и кнопка «отписаться».
//
//Отдельный экран, а не галочки прямо в списке: в списке нажатие означает «слежу / не слежу»,
//и это быстрый путь, который ломать нельзя. Тонкая настройка живёт там, где её ищут, —
//внутри своего сервера.

export type CardActionType = "toggleEvent" | "unsubscribe" | "back";

export interface CardAction {
    action: CardActionType;
    serverId: number;
    //Заполнен только у toggleEvent. Для остальных действий пустая строка.
    kind: SubscriptionEventKind | undefined;
}

const CARD_ACTION_CODE: Record<CardActionType, string> = {
    toggleEvent: "e",
    unsubscribe: "u",
    back: "b",
};

//Своё пространство кодов, отдельное от списка: у карточки другой набор действий, и мешать их
//в один разбор значит получить те самые ветвления, от которых уходили.
export const CARD_ACTION_PATTERN = new RegExp(
    `^k:[${Object.values(CARD_ACTION_CODE).join("")}]:`,
);

export function encodeCardAction(action: CardAction): string {
    return ["k", CARD_ACTION_CODE[action.action], action.serverId, action.kind ?? ""].join(":");
}

//undefined вместо исключения: кнопка может прийти из сообщения, отправленного до смены формата.
export function decodeCardAction(data: string): CardAction | undefined {
    const parts = data.split(":");

    if (parts.length !== 4 || parts[0] !== "k") {
        return undefined;
    }

    const [, code, serverId, kind] = parts;
    const action = (Object.keys(CARD_ACTION_CODE) as CardActionType[])
        .find(name => CARD_ACTION_CODE[name] === code);

    if (!action || serverId === undefined || !/^\d+$/.test(serverId)) {
        return undefined;
    }

    return {
        action,
        serverId: Number(serverId),
        kind: kind !== undefined && isSubscriptionEventKind(kind) ? kind : undefined,
    };
}

export function renderServerCard(
    server: CatalogServer,
    enabled: ReadonlySet<SubscriptionEventKind>,
): {text: string; keyboard: InlineKeyboard} {
    const keyboard = new InlineKeyboard();

    //Строки берутся из той же таблицы, что и сами типы: второго списка, который может разъехаться
    //с первым, не появляется. Добавили тип — кнопка возникает сама.
    for (const kind of Object.keys(SUBSCRIPTION_EVENT_TITLES) as SubscriptionEventKind[]) {
        keyboard
            .text(
                `${enabled.has(kind) ? "✅" : "▫️"} ${SUBSCRIPTION_EVENT_TITLES[kind]}`,
                encodeCardAction({action: "toggleEvent", serverId: server.id, kind}),
            )
            .row();
    }

    keyboard
        .text("🗑 Отписаться", encodeCardAction({action: "unsubscribe", serverId: server.id, kind: undefined}))
        .text("◀ К списку", encodeCardAction({action: "back", serverId: server.id, kind: undefined}));

    return {
        text: [
            `<b>${escapeHtml(server.name)}</b>`,
            `<code>${escapeHtml(server.gameAddress)}</code>`,
            "",
            enabled.size === 0
                ? "Ничего не присылаю — все уведомления выключены."
                : "Что присылать:",
        ].join("\n"),
        keyboard,
    };
}
