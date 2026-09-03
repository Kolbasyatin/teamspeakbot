import {InlineKeyboard} from "grammy";
import {formatDuration, intervalToDuration} from "date-fns";
import {ru} from "date-fns/locale";
import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";

//Сводка «мои серверы» для Telegram. Чистая функция, как и ServerListMessage: данные на входе,
//текст на выходе, ни сети, ни БД.
//
//Момент времени приходит параметром, а не берётся внутри через new Date(): иначе текст
//недетерминирован и проверяется только приблизительно (тот же дефект записан долгом №16
//про ChannelDescriptionRenderer).
//
//ВЁРСТКА. Две строки на сервер: имя отдельно, факты отдельно. В одну строку не помещается —
//названия длинные, и телефон переносит их как попало, разрывая «27/64» и время. Настоящей таблицы
//в Telegram нет: моноширинный блок выравнял бы колонки, но на узком экране начал бы переноситься
//так же, только ещё и без переноса по словам.
//
//Разметка HTML, а не Markdown: в MarkdownV2 экранировать пришлось бы почти всю пунктуацию,
//включая точки и дефисы, которых в названиях серверов полно. В HTML достаточно трёх символов.

//Сервер, на который человек подписан, но которого нет в опросе: его скрыли из каталога уже
//после подписки. Показать его надо, иначе список молча короче, чем подписки.
export interface UnmonitoredServer {
    name: string;
}

const STATUS_MARK = {
    online: "🟢",
    offline: "🔴",
    unknown: "⚪",
} as const;

const PLAYERS = "👥";
const CLOCK = "⏱";
const QUEUE = "⏳";

//Единственная кнопка этого сообщения, поэтому и протокол у неё вырожденный — одна константа.
//Разбирать нечего: что нажали, известно из самого факта нажатия.
//С форматом списка не пересекается: там ровно пять частей через двоеточие, здесь две.
export const STATUS_REFRESH = "s:r";

const MOSCOW_TIME = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Moscow",
});

export function renderServerStatus(
    snapshots: readonly ServerProbeSnapshot[],
    unmonitored: readonly UnmonitoredServer[],
    now: Date,
): {text: string; keyboard: InlineKeyboard} {
    return {
        text: renderText(snapshots, unmonitored, now),
        keyboard: new InlineKeyboard().text("🔄 Обновить", STATUS_REFRESH),
    };
}

function renderText(
    snapshots: readonly ServerProbeSnapshot[],
    unmonitored: readonly UnmonitoredServer[],
    now: Date,
): string {
    //Отметка времени внизу — не украшение. Данные между двумя нажатиями часто совпадают до буквы
    //(длительность округлена до минут, игроки меняются редко), а Telegram отказывается править
    //сообщение тем же текстом: «message is not modified». Без отметки кнопка выглядела бы
    //сломанной — нажал, и ничего не произошло.
    const updated = `<i>обновлено ${MOSCOW_TIME.format(now)}</i>`;

    if (snapshots.length === 0 && unmonitored.length === 0) {
        return `Ты пока ни на что не подписан. Открой /serverlist и выбери серверы.\n\n${updated}`;
    }

    const entries = [
        ...snapshots.map(snapshot => renderEntry(snapshot, now)),
        ...unmonitored.map(server => `⚪ <b>${escapeHtml(server.name)}</b>\nне отслеживается`),
    ];

    //Пустая строка между серверами: без неё две строки одного сервера сливаются с двумя строками
    //следующего, и глазом их не разделить.
    return [`<b>Твои серверы: ${entries.length}</b>`, ...entries, updated].join("\n\n");
}

function renderEntry(snapshot: ServerProbeSnapshot, now: Date): string {
    const title = `${STATUS_MARK[snapshot.status]} <b>${escapeHtml(snapshot.config.name)}</b>`;
    const since = `${CLOCK} ${formatSince(snapshot.statusSince, now)}`;

    if (snapshot.status === "offline") {
        return `${title}\n${CLOCK} офлайн ${formatSince(snapshot.statusSince, now)}`;
    }

    const players = snapshot.currentInfo?.players;
    const maxPlayers = snapshot.currentInfo?.maxPlayers;

    //Данных может не быть и у живого сервера: статус unknown до первого удачного опроса,
    //или ответил только тот источник, который игроков не отдаёт. Правило то же, что у табло
    //в TeamSpeak: нет чисел — так и говорим, а не показываем ноль.
    if (players === undefined || maxPlayers === undefined) {
        return `${title}\n${PLAYERS} нет данных   ${since}`;
    }

    return [`${title}\n${PLAYERS} ${players}/${maxPlayers}   ${since}`, renderQueue(snapshot, now)]
        .filter(line => line !== "")
        .join("\n");
}

//Строка про очередь. Появляется, только если источник очереди вообще ответил: нет поля —
//нет строки, а не «очереди нет». Пустая очередь при этом показывается: у полного сервера
//это самостоятельный факт («128/128, но зайти можно сразу»).
//
//Свежесть стоит именно здесь, а не у игроков: игроки приезжают по A2S прямо с сервера
//на каждом опросе, а очередь — из каталога Bohemia с задержкой heartbeat'а и опрашивается
//реже. Возраст считается по dataUpdatedAt источника, который очередь и принёс.
function renderQueue(snapshot: ServerProbeSnapshot, now: Date): string {
    const info = snapshot.currentInfo;
    const size = info?.queueSize;

    if (size === undefined) {
        return "";
    }

    const queue = size === 0
        ? "без очереди"
        : `очередь ${size}${info?.queueMaxSize === undefined ? "" : `/${info.queueMaxSize}`}`;
    const freshness = info?.dataUpdatedAt === undefined
        ? ""
        : ` · ${formatAge(new Date(info.dataUpdatedAt), now)}`;

    return `${QUEUE} ${queue}${freshness}`;
}

//Возраст данных. Моложе минуты — «только что»: секунды здесь точность ложная, каталог сам
//обновляется с шагом в десятки секунд.
function formatAge(dataUpdatedAt: Date, now: Date): string {
    const duration = formatDuration(intervalToDuration({start: dataUpdatedAt, end: now}), {
        locale: ru,
        format: ["days", "hours", "minutes"],
        zero: false,
    });

    return duration ? `${duration} назад` : "только что";
}

//Сколько длится текущий статус.
function formatSince(statusSince: Date, now: Date): string {
    return formatDuration(intervalToDuration({start: statusSince, end: now}), {
        locale: ru,
        format: ["hours", "minutes"],
        zero: false,
    }) || "меньше минуты";
}

//Имя сервера приходит из БД и может содержать что угодно. Незакрытый «<» в нём — это не кривая
//вёрстка, а отказ Telegram разобрать сообщение целиком, то есть /status перестанет отвечать.
function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
