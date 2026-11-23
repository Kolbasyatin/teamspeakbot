import {InlineKeyboard} from "grammy";
import {escapeHtml} from "./escapeHtml.js";
import {fitMessage} from "./fitMessage.js";
import type {
    BroadcastStatus,
    BroadcastTarget,
    DeliveryCounts,
    ListMember,
    ListNameProblem,
    ListsOverview,
    MembershipChange,
    StoredBroadcast,
} from "../broadcasts/Broadcasts.js";

//Тексты рассылок и списков (итерация 24). Чистые функции: проверяются без grammy и без сети.

export const BROADCAST_CONFIRM_PATTERN = /^bc:([yn]):(\d+)$/;

export function encodeBroadcastDecision(decision: "y" | "n", broadcastId: number): string {
    return `bc:${decision}:${broadcastId}`;
}

export function decodeBroadcastDecision(data: string): {confirm: boolean; broadcastId: number} | undefined {
    const match = BROADCAST_CONFIRM_PATTERN.exec(data);
    const broadcastId = match ? Number(match[2]) : undefined;

    return match && broadcastId !== undefined && Number.isSafeInteger(broadcastId)
        ? {confirm: match[1] === "y", broadcastId}
        : undefined;
}

export const SEND_USAGE = [
    "<b>Как отправить</b>",
    "Ответом на своё сообщение (разметка и вложения сохранятся): /send &lt;кому&gt;",
    "Или текстом: /send &lt;кому&gt; текст объявления",
    "",
    "Кому: chat_id (личка или группа), имя списка, <code>all</code> — все, <code>unsorted</code> — кто не в списках.",
    "Списки — /lists.",
].join("\n");

export const LISTS_USAGE = [
    "<b>Списки рассылки</b>",
    "/lists — все списки; /lists &lt;имя&gt; — участники",
    "/list_add &lt;имя&gt; [описание] — создать",
    "/list_delete &lt;имя&gt; — удалить",
    "/list_include &lt;имя&gt; &lt;chat_id…&gt; — добавить (или ответом на сообщение человека)",
    "/list_exclude &lt;имя&gt; &lt;chat_id…&gt; — убрать",
].join("\n");

export const LIST_NAME_PROBLEM_TEXT: Record<ListNameProblem, string> = {
    format: "Имя списка — латиница в нижнем регистре, цифры и «_», от 2 до 32 символов, с буквы: klan, testers_2.",
    reserved: "all и unsorted — встроенные адресаты, так список назвать нельзя.",
};

export function describeTargetHuman(target: BroadcastTarget): string {
    switch (target.kind) {
        case "chat":
            return `чат <code>${target.chatId}</code>`;
        case "list":
            return `список <b>${escapeHtml(target.name)}</b>`;
        case "all":
            return "все чаты";
        case "unsorted":
            return "чаты без списка (unsorted)";
    }
}

export function renderConfirmation(
    broadcastId: number,
    target: BroadcastTarget,
    recipients: number,
    preview: string | undefined,
): {text: string; keyboard: InlineKeyboard} {
    const text = [
        `📣 <b>Рассылка #${broadcastId}</b> → ${describeTargetHuman(target)}: ${recipients} ${chats(recipients)}`,
        preview ? `<i>${escapeHtml(cut(preview, 200))}</i>` : "<i>вложение без текста</i>",
        "",
        "Отправить?",
    ].join("\n");
    const keyboard = new InlineKeyboard()
        .text("✅ Отправить", encodeBroadcastDecision("y", broadcastId))
        .text("❌ Отмена", encodeBroadcastDecision("n", broadcastId));

    return {text, keyboard};
}

export function renderStarted(broadcastId: number, target: BroadcastTarget): string {
    return `📣 Рассылка #${broadcastId} → ${describeTargetHuman(target)}: отправляю. Отчёт придёт отдельным сообщением.`;
}

export function renderCancelled(broadcastId: number): string {
    return `Рассылка #${broadcastId} отменена.`;
}

export function renderReport(broadcast: StoredBroadcast, counts: DeliveryCounts): string {
    const lines = [
        `📣 <b>Рассылка #${broadcast.id}</b> → ${describeTargetHuman(broadcast.target)}: готово`,
        `Доставлено ${counts.delivered} из ${counts.recipients}.`,
    ];

    if (counts.blocked > 0) {
        lines.push(`Недоступны насовсем (заблокировали бота, удалили аккаунт, выгнали бота): ${counts.blocked} — в следующие рассылки по спискам не попадут.`);
    }

    if (counts.failed > 0) {
        lines.push(`Ошибок: ${counts.failed}. Кому именно — в /chats &lt;chat_id&gt;.`);
    }

    return lines.join("\n");
}

const STATUS_TEXT: Record<BroadcastStatus, string> = {
    pending: "ждёт подтверждения",
    sending: "идёт",
    done: "готово",
    cancelled: "отменена",
    interrupted: "прервана перезапуском бота",
};

const STAMP = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
});

export function renderRecentBroadcasts(broadcasts: readonly StoredBroadcast[]): string {
    if (broadcasts.length === 0) {
        return "Рассылок ещё не было.";
    }

    const lines = ["<b>Последние рассылки</b>"];

    for (const broadcast of broadcasts) {
        const counts = broadcast.status === "done"
            ? ` · ${broadcast.delivered}/${broadcast.recipients}${broadcast.blocked ? `, недоступны ${broadcast.blocked}` : ""}${broadcast.failed ? `, ошибок ${broadcast.failed}` : ""}`
            : "";

        lines.push(
            "",
            `#${broadcast.id} · ${STAMP.format(broadcast.createdAt)} · ${describeTargetHuman(broadcast.target)} · ${STATUS_TEXT[broadcast.status]}${counts}`,
            `<i>${escapeHtml(cut(broadcast.preview ?? "вложение без текста", 120))}</i> · автор <code>${broadcast.authorUserId}</code>`,
        );
    }

    return fitMessage(lines);
}

export function renderListsOverview(overview: ListsOverview): string {
    const lines = [
        "<b>Списки рассылки</b>",
        `all — все: ${overview.all}`,
        `unsorted — не в списках: ${overview.unsorted}`,
        ...(overview.blocked > 0 ? [`(недоступны насовсем: ${overview.blocked} — в рассылки не попадают)`] : []),
        "",
    ];

    if (overview.lists.length === 0) {
        lines.push("Своих списков пока нет. Создать — /list_add &lt;имя&gt; [описание].");
    }

    for (const list of overview.lists) {
        const description = list.description ? ` — ${escapeHtml(list.description)}` : "";
        lines.push(`<b>${escapeHtml(list.name)}</b>: ${list.members}${description}`);
    }

    lines.push("", "Участники списка — /lists &lt;имя&gt;. Все команды — /lists help.");

    return fitMessage(lines);
}

export function renderListMembers(name: string, members: readonly ListMember[]): string {
    const lines = [`<b>Список ${escapeHtml(name)}</b>: ${members.length}`];

    if (members.length === 0) {
        lines.push("Пусто. Добавить — /list_include " + escapeHtml(name) + " &lt;chat_id…&gt;.");
    }

    for (const member of members) {
        const icon = member.type === "private" ? "👤" : member.type === "channel" ? "📢" : "👥";
        const blocked = member.blocked ? " · 🚫 недоступен" : "";
        lines.push(`${icon} ${escapeHtml(member.title ?? "без имени")} — <code>${member.chatId}</code>${blocked}`);
    }

    return fitMessage(lines);
}

export function renderMembershipChange(verb: "include" | "exclude", name: string, change: MembershipChange): string {
    const list = escapeHtml(name);
    const ids = (chatIds: readonly number[]): string => chatIds.map(chatId => `<code>${chatId}</code>`).join(", ");
    const lines: string[] = [];

    if (change.changed.length > 0) {
        lines.push(`${verb === "include" ? "Добавлены в" : "Убраны из"} ${list}: ${ids(change.changed)}`);
    }

    if (change.unchanged.length > 0) {
        lines.push(`${verb === "include" ? "Уже были в" : "Не было в"} ${list}: ${ids(change.unchanged)}`);
    }

    if (change.unknown.length > 0) {
        lines.push(`Боту не писали — добавить нельзя, пусть нажмут /start: ${ids(change.unknown)}`);
    }

    return lines.join("\n");
}

function chats(count: number): string {
    const lastTwo = count % 100;
    const last = count % 10;

    if (lastTwo >= 11 && lastTwo <= 14) {
        return "чатов";
    }

    return last === 1 ? "чат" : last >= 2 && last <= 4 ? "чата" : "чатов";
}

function cut(text: string, limit: number): string {
    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
