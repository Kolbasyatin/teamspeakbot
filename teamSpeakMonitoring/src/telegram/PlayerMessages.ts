import {formatDuration, intervalToDuration} from "date-fns";
import {ru} from "date-fns/locale";
import {InlineKeyboard} from "grammy";
import type {ObservedPlayer, PlayerEvent, PlayerSession} from "../players/PlayerObserver.js";
import {escapeHtml} from "./escapeHtml.js";

//Тексты про игроков. Чистые функции, как ServerStatusMessage: данные на входе, текст на выходе,
//ни сети, ни БД, ни new Date() внутри — момент времени приходит параметром, иначе результат
//недетерминирован и проверяется только приблизительно.

const ONLINE = "🟢";
const OFFLINE = "⚪";
const QUEUE = "🕒";
const RENAME = "✏️";

//Метка выбора игрока из результатов поиска. Формат: p:<playerId>. С форматами списка серверов
//(пять частей) и карточки не пересекается: там своя первая буква и своё число частей.
export const PLAYER_PICK_PATTERN = /^p:(\d+)$/;

export function encodePlayerPick(playerId: number): string {
    return `p:${playerId}`;
}

export function decodePlayerPick(data: string): number | undefined {
    const match = PLAYER_PICK_PATTERN.exec(data);

    return match?.[1] === undefined ? undefined : Number(match[1]);
}

//Кнопка «никого из них — жду этот ник». Формат: pw:<ник>. С кнопками выбора (p:<число>),
//списка серверов (c:/m:) и карточки (k:) не пересекается.
export const PLAYER_WAIT_PATTERN = /^pw:/;

//Telegram ограничивает callback_data 64 БАЙТАМИ, а ник — произвольный UTF-8: кириллица по два
//байта, эмодзи по четыре. Ник, который не влезает, кнопкой не обслуживается — вместо неё
//показывается подсказка про команду /wait. Молча обрезать ник нельзя: ждали бы не того человека.
const CALLBACK_DATA_LIMIT = 64;

export function encodePlayerWait(nickname: string): string | undefined {
    const data = `pw:${nickname}`;

    return Buffer.byteLength(data, "utf8") <= CALLBACK_DATA_LIMIT ? data : undefined;
}

export function decodePlayerWait(data: string): string | undefined {
    if (!PLAYER_WAIT_PATTERN.test(data)) {
        return undefined;
    }

    const nickname = data.slice("pw:".length);

    return nickname === "" ? undefined : nickname;
}

//Человекочитаемая длительность: «8 мин», «1 ч 12 мин». Секунды показываются только когда
//других единиц нет, иначе «1 ч 12 мин 4 сек» — шум.
export function humanDuration(seconds: number): string {
    if (seconds < 60) {
        return `${Math.max(0, Math.round(seconds))} сек`;
    }

    const duration = intervalToDuration({start: 0, end: Math.round(seconds) * 1_000});

    return formatDuration(duration, {
        format: ["years", "months", "days", "hours", "minutes"],
        locale: ru,
        delimiter: " ",
    });
}

//«3 ч назад». Для ответа на вопрос «когда его видели в последний раз».
export function humanAgo(moment: Date, now: Date): string {
    return `${humanDuration((now.getTime() - moment.getTime()) / 1_000)} назад`;
}

const MOSCOW_TIME = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
});

const MOSCOW_DATE_TIME = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
});

//Строка одного игрока для списка подписок: где он сейчас или когда был в последний раз.
export function renderPlayerLine(player: ObservedPlayer, now: Date): string {
    const nickname = `<b>${escapeHtml(player.currentNickname)}</b>`;

    if (player.online) {
        const since = player.online.since
            ? `, ${humanDuration((now.getTime() - player.online.since.getTime()) / 1_000)}`
            : "";

        return `${ONLINE} ${nickname} — ${escapeHtml(player.online.serverName)}${since}`;
    }

    const where = player.lastServer ? ` на ${escapeHtml(player.lastServer.serverName)}` : "";

    return `${OFFLINE} ${nickname} — офлайн, был ${humanAgo(player.lastSeenAt, now)}${where}`;
}

//Список подписок чата. Онлайн-игроки приходят от сервиса первыми, порядок не меняем.
export function renderSubscriptions(
    players: readonly ObservedPlayer[],
    pending: readonly string[],
    now: Date,
): string {
    if (players.length === 0 && pending.length === 0) {
        return [
            "Вы ни за кем не следите.",
            "",
            "/watch &lt;ник&gt; — найти игрока и подписаться на его вход и выход.",
        ].join("\n");
    }

    const lines = [`Ваши подписки (${players.length}):`, ""];

    lines.push(...players.map(player => renderPlayerLine(player, now)));

    if (pending.length > 0) {
        lines.push("", "Ожидают появления:");
        lines.push(...pending.map(nickname => `⏳ ${escapeHtml(nickname)}`));
    }

    return lines.join("\n");
}

//Карточка игрока: всё, что о нём известно.
export function renderPlayerCard(player: ObservedPlayer, subscribed: boolean, now: Date): {
    text: string;
    keyboard: InlineKeyboard;
} {
    const lines = [`<b>${escapeHtml(player.currentNickname)}</b>`];

    if (player.online) {
        const since = player.online.since
            ? ` (${humanDuration((now.getTime() - player.online.since.getTime()) / 1_000)})`
            : "";

        lines.push(`${ONLINE} сейчас на ${escapeHtml(player.online.serverName)}${since}`);
    } else {
        const where = player.lastServer ? ` на ${escapeHtml(player.lastServer.serverName)}` : "";

        lines.push(`${OFFLINE} офлайн, последний раз ${humanAgo(player.lastSeenAt, now)}${where}`);
    }

    //Прошлые ники показываем только если они есть: строка «Ники: Вася» ничего не сообщает.
    const otherNames = player.aliases.filter(alias => alias !== player.currentNickname);

    if (otherNames.length > 0) {
        lines.push(`Другие ники: ${otherNames.map(escapeHtml).join(", ")}`);
    }

    if (player.platforms.length > 0) {
        lines.push(`Платформы: ${player.platforms.map(platform => platformTitle(platform.type)).join(", ")}`);
    }

    lines.push(`Визитов: ${player.sessionsTotal}, впервые замечен ${humanAgo(player.firstSeenAt, now)}`);

    const keyboard = new InlineKeyboard();

    //Кнопка ровно одна и противоположна текущему состоянию: подписан — «отписаться», и наоборот.
    keyboard.text(subscribed ? "Отписаться" : "Подписаться", encodePlayerPick(player.playerId));

    return {text: lines.join("\n"), keyboard};
}

//Кандидаты поиска. Ник не уникален, поэтому выбирать человек будет по различающим признакам:
//где сейчас или где был, платформа, когда видели.
//
//query — то, что человек искал. Нужен для выхода из списка: среди найденных может не быть НИКОГО
//из тех, кто нужен, потому что искомый игрок ещё не заходил на наблюдаемые серверы. Без этой кнопки
//человек упирается в тупик: похожие есть, значит ожидание ему не предложили, а выбрать некого.
//Пустой query кнопку убирает — так вызывается разбор тёзок при отписке, где ждать нечего.
export function renderSearchResults(
    players: readonly ObservedPlayer[],
    fuzzy: boolean,
    now: Date,
    query = "",
): {
    text: string;
    keyboard: InlineKeyboard;
} {
    const lines = fuzzy
        ? ["Точных совпадений нет. Возможно, вы имели в виду:", ""]
        : ["Нашлось несколько игроков с таким ником:", ""];

    const keyboard = new InlineKeyboard();

    players.forEach((player, index) => {
        lines.push(`${index + 1}. ${renderPlayerLine(player, now)}`);
        keyboard.text(`${index + 1}. ${player.currentNickname}`, encodePlayerPick(player.playerId)).row();
    });

    lines.push("", "Выберите, за кем следить.");

    if (query !== "") {
        const waitData = encodePlayerWait(query);

        if (waitData === undefined) {
            //Ник не влезает в callback_data — остаётся команда.
            lines.push(`Никого из них? Тогда /wait ${query} — запомню ник и напишу, когда появится.`);
        } else {
            lines.push("Никого из них? Нажмите кнопку ниже — запомню ник и напишу, когда он появится.");
            keyboard.text(`🔔 Ждать «${query}»`, waitData).row();
        }
    }

    return {text: lines.join("\n"), keyboard};
}

//История визитов. Ник визита показывается, только если отличается от текущего: иначе он дублирует
//заголовок в каждой строке.
export function renderSessions(player: ObservedPlayer, sessions: readonly PlayerSession[], now: Date): string {
    if (sessions.length === 0) {
        return `${escapeHtml(player.currentNickname)}: визитов не записано.`;
    }

    const lines = [`<b>${escapeHtml(player.currentNickname)}</b> — последние визиты:`, ""];

    for (const session of sessions) {
        const start = MOSCOW_DATE_TIME.format(session.firstSeenAt);
        const end = session.endedAt ? MOSCOW_TIME.format(session.endedAt) : "сейчас";
        const nickname = session.nickname !== "" && session.nickname !== player.currentNickname
            ? `, ник «${escapeHtml(session.nickname)}»`
            : "";
        //Разрыв наблюдения означает, что длительность занижена или завышена: молчать об этом нельзя,
        //иначе цифра выглядит измеренной.
        const gap = session.status === "CLOSED_DATA_GAP" ? " (данные прерывались)" : "";

        lines.push(
            `${start} – ${end} (${humanDuration(session.durationSeconds)}) — ${escapeHtml(session.serverName)}${nickname}${gap}`,
        );
    }

    return lines.join("\n");
}

//Уведомление по событию ленты. undefined — событие, о котором мы не умеем рассказать:
//тип из чужого сервиса, которого ещё нет в боте. Молчание лучше строки «PLAYER_XXX».
export function renderEvent(event: PlayerEvent): string | undefined {
    const nickname = `<b>${escapeHtml(event.nickname)}</b>`;
    const server = escapeHtml(event.serverName);
    const at = MOSCOW_TIME.format(event.occurredAt);
    //Момент входа после разрыва наблюдения неточен — человек должен это видеть, иначе время
    //выглядит измеренным.
    const approximate = event.afterDataGap ? " (время приблизительное)" : "";

    switch (event.type) {
        case "PLAYER_JOINED_SERVER":
            return `${ONLINE} ${nickname} зашёл на ${server} в ${at}${approximate}`;
        case "PLAYER_LEFT_SERVER": {
            const spent = event.durationSeconds === undefined
                ? ""
                : `, провёл ${humanDuration(event.durationSeconds)}`;

            return `${OFFLINE} ${nickname} вышел с ${server} в ${at}${spent}`;
        }
        case "PLAYER_ENTERED_QUEUE":
            return `${QUEUE} ${nickname} встал в очередь на ${server}`;
        case "PLAYER_LEFT_QUEUE": {
            const waited = event.durationSeconds === undefined
                ? ""
                : ` после ${humanDuration(event.durationSeconds)} в очереди`;

            return event.payload["result"] === "JOINED_SERVER"
                ? `${ONLINE} ${nickname} вошёл на ${server}${waited}`
                : `${OFFLINE} ${nickname} ушёл из очереди ${server}${waited}`;
        }
        case "PLAYER_NICKNAME_CHANGED": {
            const to = typeof event.payload["new"] === "string" ? event.payload["new"] : "";

            return to === "" ? undefined : `${RENAME} ${nickname} теперь <b>${escapeHtml(to)}</b>`;
        }
        default:
            return undefined;
    }
}

function platformTitle(type: string): string {
    switch (type) {
        case "PLATFORM_PC":
            return "PC";
        case "PLATFORM_PSN":
            return "PlayStation";
        case "PLATFORM_XBL":
            return "Xbox";
        default:
            return type;
    }
}
