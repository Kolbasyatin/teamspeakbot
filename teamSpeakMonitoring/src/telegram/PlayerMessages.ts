import {formatDuration, intervalToDuration} from "date-fns";
import {ru} from "date-fns/locale";
import {InlineKeyboard} from "grammy";
import type {DossierFriend, ObservedPlayer, PlayerDossier, PlayerEvent, PlayerSession, SteamProfile} from "../players/PlayerObserver.js";
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

//Кнопка «показать досье». Формат: pi:<playerId>. Число короткое, в 64 байта callback_data
//влезает всегда — в отличие от ника, из-за которого кнопке ожидания нужна отдельная проверка.
export const PLAYER_INFO_PATTERN = /^pi:(\d+)$/;

export function encodePlayerInfo(playerId: number): string {
    return `pi:${playerId}`;
}

export function decodePlayerInfo(data: string): number | undefined {
    const match = PLAYER_INFO_PATTERN.exec(data);

    return match?.[1] === undefined ? undefined : Number(match[1]);
}

//Кнопки выбора из списка тёзок для команд, которые НИЧЕГО НЕ МЕНЯЮТ: pc:<id> — показать
//карточку, ph:<id> — показать историю визитов.
//
//Отдельные метки, а не общая p:<id>, потому что та переключает подписку. Пока список тёзок
//был один на все команды, выбор имени в /where, /history и /playerinfo молча подписывал
//или отписывал человека: команда спрашивала «кого показать», а по нажатию отвечала
//«больше не слежу за Zalex».
export const PLAYER_CARD_PATTERN = /^pc:(\d+)$/;
export const PLAYER_HISTORY_PATTERN = /^ph:(\d+)$/;

export function encodePlayerCard(playerId: number): string {
    return `pc:${playerId}`;
}

export function decodePlayerCard(data: string): number | undefined {
    const match = PLAYER_CARD_PATTERN.exec(data);

    return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function encodePlayerHistory(playerId: number): string {
    return `ph:${playerId}`;
}

export function decodePlayerHistory(data: string): number | undefined {
    const match = PLAYER_HISTORY_PATTERN.exec(data);

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
): {
    text: string;
    keyboard: InlineKeyboard;
} {
    const keyboard = new InlineKeyboard();

    if (players.length === 0 && pending.length === 0) {
        return {
            text: [
                "Вы ни за кем не следите.",
                "",
                "/watch &lt;ник&gt; — найти игрока и подписаться на его вход и выход.",
            ].join("\n"),
            keyboard,
        };
    }

    const lines = [`Ваши подписки (${players.length}):`, ""];

    lines.push(...players.map(player => renderPlayerLine(player, now)));

    if (pending.length > 0) {
        lines.push("", "Ожидают появления:");
        lines.push(...pending.map(nickname => `⏳ ${escapeHtml(nickname)}`));
    }

    //Кнопки досье прямо из списка: иначе человек, глядя на подписки, должен вручную набрать
    ///playerinfo с ником, который у него перед глазами. Показываем первых SUBSCRIPTION_BUTTONS —
    //клавиатура на три десятка строк нечитаема, а у остальных есть команда.
    const withButtons = players.slice(0, SUBSCRIPTION_BUTTONS);

    for (const player of withButtons) {
        keyboard.text(`🔎 ${player.currentNickname}`, encodePlayerInfo(player.playerId)).row();
    }

    if (players.length > withButtons.length) {
        lines.push("", `Досье остальных — /playerinfo &lt;ник&gt;`);
    }

    return {text: lines.join("\n"), keyboard};
}

//Сколько кнопок досье показывать под списком подписок.
const SUBSCRIPTION_BUTTONS = 8;

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

    //Кнопка подписки противоположна текущему состоянию: подписан — «отписаться», и наоборот.
    keyboard.text(subscribed ? "Отписаться" : "Подписаться", encodePlayerPick(player.playerId));
    //Досье рядом: человек уже смотрит на игрока, и вводить /playerinfo с ником заново — лишний шаг.
    keyboard.text("🔎 Досье", encodePlayerInfo(player.playerId));

    return {text: lines.join("\n"), keyboard};
}

//Кандидаты поиска. Ник не уникален, поэтому выбирать человек будет по различающим признакам:
//где сейчас или где был, платформа, когда видели.
//
//query — то, что человек искал. Нужен для выхода из списка: среди найденных может не быть НИКОГО
//из тех, кто нужен, потому что искомый игрок ещё не заходил на наблюдаемые серверы. Без этой кнопки
//человек упирается в тупик: похожие есть, значит ожидание ему не предложили, а выбрать некого.
//Пустой query кнопку убирает — так вызывается разбор тёзок при отписке, где ждать нечего.
//Зачем открыли список тёзок. От этого зависит и что делает кнопка, и что написано внизу:
//"watch" — подписаться (единственный случай, когда нажатие что-то меняет), остальные только
//показывают. Предложение «ждать ник» уместно тоже лишь для подписки.
export type PickerIntent = "watch" | "card" | "history" | "info";

const PICKER: Record<PickerIntent, {encode: (playerId: number) => string; footer: string}> = {
    watch: {encode: encodePlayerPick, footer: "Выберите, за кем следить."},
    card: {encode: encodePlayerCard, footer: "Выберите, о ком показать сведения."},
    history: {encode: encodePlayerHistory, footer: "Выберите, чью историю показать."},
    info: {encode: encodePlayerInfo, footer: "Выберите, чьё досье показать."},
};

export function renderSearchResults(
    players: readonly ObservedPlayer[],
    fuzzy: boolean,
    now: Date,
    query = "",
    intent: PickerIntent = "watch",
): {
    text: string;
    keyboard: InlineKeyboard;
} {
    const lines = fuzzy
        ? ["Точных совпадений нет. Возможно, вы имели в виду:", ""]
        : ["Нашлось несколько игроков с таким ником:", ""];

    const keyboard = new InlineKeyboard();
    const picker = PICKER[intent];

    players.forEach((player, index) => {
        lines.push(`${index + 1}. ${renderPlayerLine(player, now)}`);
        keyboard.text(`${index + 1}. ${player.currentNickname}`, picker.encode(player.playerId)).row();
    });

    lines.push("", picker.footer);

    //«Ждать ник» предлагается только при подписке: для показа сведений ждать нечего,
    //а кнопка рядом со списком сбивала с толку — она появлялась даже тогда, когда нужный
    //игрок в списке уже был.
    if (query !== "" && intent === "watch") {
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

//Сколько прежних ников показываем: у долгоживущего игрока их бывают десятки, а сообщение
//в Telegram ограничено 4096 символами.
const ALIAS_LIMIT = 25;

//Все ники найденных игроков. Смысл команды: поиск у наблюдателя идёт по ВСЕМ алиасам, поэтому
//достаточно назвать любое из имён игрока, чтобы получить остальные.
//
//Кнопок здесь нет намеренно: это справка, а не выбор. Показываем сразу всех, кто подошёл,
//вместо того чтобы просить уточнить — однофамильцев видно рядом, и это как раз то, что нужно.
export function renderAliases(
    players: readonly ObservedPlayer[],
    fuzzy: boolean,
    query: string,
    now: Date,
): string {
    if (players.length === 0) {
        return `Игрока «${escapeHtml(query)}» мы не видели — ни под этим ником, ни под похожими.`;
    }

    const lines = fuzzy
        ? [`Точного совпадения с «${escapeHtml(query)}» нет. Возможно, вы имели в виду:`, ""]
        : [];

    players.forEach((player, index) => {
        //Нумеруем, только когда есть из чего выбирать: «1.» у единственного игрока — шум.
        const number = players.length > 1 ? `${index + 1}. ` : "";

        lines.push(`${number}${renderPlayerLine(player, now)}`);
        lines.push(renderAliasList(player));
        lines.push("");
    });

    return lines.join("\n").trimEnd();
}

function renderAliasList(player: ObservedPlayer): string {
    //Текущий ник наблюдатель отдаёт первым, и в заголовке строки он уже назван — в «прежних»
    //его не повторяем. Сравнение точное: регистр здесь значим, «Salat» и «salat» — разные ники.
    const previous = player.aliases.filter(alias => alias !== player.currentNickname);

    if (previous.length === 0) {
        return `${RENAME} Других ников не было.`;
    }

    const shown = previous.slice(0, ALIAS_LIMIT).map(alias => escapeHtml(alias)).join(", ");
    const rest = previous.length > ALIAS_LIMIT ? ` и ещё ${previous.length - ALIAS_LIMIT}` : "";

    return `${RENAME} Прежние ники (${previous.length}): ${shown}${rest}`;
}

//Досье Steam. Всё необязательное показывается ТОЛЬКО когда известно: строка «VAC: нет»
//у несобранных банов и «0 часов» у скрытых игр одинаково вводят в заблуждение.
export function renderDossier(player: ObservedPlayer, dossier: PlayerDossier, now: Date): string {
    const profile = dossier.profile;
    const lines = [`<b>${escapeHtml(player.currentNickname)}</b> — досье Steam`, ""];

    //Данных нет вовсе. Отрисовать по пустому профилю «библиотека скрыта» было бы прямой
    //неправдой: скрытую библиотеку мы видели, а тут не видели ничего.
    if (profile === undefined) {
        lines.push("Данные Steam по этому игроку ещё не собраны.");

        if (dossier.lastError !== "") {
            lines.push("", `Причина: ${escapeHtml(dossier.lastError)}`);
        } else {
            lines.push("", "Он поставлен в очередь — загляните позже.");
        }

        return lines.join("\n");
    }

    if (profile.personaName !== "") {
        const real = profile.realName === "" ? "" : ` (${escapeHtml(profile.realName)})`;

        lines.push(`Ник в Steam: ${escapeHtml(profile.personaName)}${real}`);
    }

    if (profile.createdAt) {
        lines.push(`Аккаунт создан: ${formatDate(profile.createdAt)} (${humanAgo(profile.createdAt, now)})`);
    }

    if (profile.countryCode !== "") {
        lines.push(`Страна: ${escapeHtml(profile.countryCode)}`);
    }

    //Наигранное — главное число для нас. Скрытые игры честно называем скрытыми:
    //отсутствие данных и ноль часов — разные вещи, и путать их нельзя.
    if (profile.gamesVisible) {
        if (profile.reforgerMinutes === undefined) {
            lines.push("Reforger: в библиотеке не числится");
        } else {
            const recent = profile.reforgerMinutes2w === undefined
                ? ""
                : `, за 2 недели ${humanHours(profile.reforgerMinutes2w)}`;

            lines.push(`Reforger: ${humanHours(profile.reforgerMinutes)}${recent}`);
        }
    } else {
        lines.push("Reforger: библиотека игр скрыта");
    }

    const bans = renderBans(profile);

    if (bans !== undefined) {
        lines.push(bans);
    }

    lines.push("", renderDossierFriends(dossier, profile, now));

    if (profile.profileUrl !== "") {
        lines.push("", profile.profileUrl);
    }

    lines.push("", `<i>данные собраны ${humanAgo(profile.updatedAt, now)}</i>`);

    return lines.join("\n");
}

function renderBans(profile: SteamProfile): string | undefined {
    if (profile.vacBanned === undefined) {
        return undefined;
    }

    if (!profile.vacBanned && (profile.gameBanCount ?? 0) === 0) {
        return "Баны: чисто";
    }

    const parts: string[] = [];

    if (profile.vacBanned) {
        parts.push(`VAC ${profile.vacBanCount ?? 1}`);
    }

    if ((profile.gameBanCount ?? 0) > 0) {
        parts.push(`игровых ${profile.gameBanCount}`);
    }

    return `⛔ Баны: ${parts.join(", ")}`;
}

//Профиль передаётся отдельным параметром, а не берётся из досье: к этому месту он уже
//проверен на наличие, и компилятору это нужно сказать явно.
function renderDossierFriends(dossier: PlayerDossier, profile: SteamProfile, now: Date): string {
    if (!profile.friendsVisible) {
        return "Друзья: список скрыт";
    }

    if (dossier.friends.length === 0) {
        return "Друзья: никого";
    }

    //Ценность графа именно в пересечении: не «у него 200 друзей», а «вот эти двое из них
    //тоже ходят на наши серверы».
    const known = dossier.friends.filter(friend => friend.playerId !== undefined);
    const head = `Друзья: ${dossier.friends.length}, из них у нас замечены ${known.length}`;

    if (known.length === 0) {
        return head;
    }

    const shown = known.slice(0, DOSSIER_FRIENDS).map(friend => {
        const seen = friend.lastSeenAt ? `, был ${humanAgo(friend.lastSeenAt, now)}` : "";

        return `  • ${escapeHtml(friend.nickname || friend.steamId)}${seen}`;
    });

    if (known.length > shown.length) {
        shown.push(`  • и ещё ${known.length - shown.length}`);
    }

    return [head, ...shown].join("\n");
}

const DOSSIER_FRIENDS = 10;

//Минуты Valve в часы. Меньше часа показываем минутами: «0 ч» у новичка выглядит как ошибка.
function humanHours(minutes: number): string {
    if (minutes < 60) {
        return `${minutes} мин`;
    }

    return `${Math.round(minutes / 60).toLocaleString("ru-RU")} ч`;
}

function formatDate(date: Date): string {
    return date.toLocaleDateString("ru-RU", {year: "numeric", month: "long", day: "numeric", timeZone: "UTC"});
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
            //Оба имени берутся из payload, а не из event.nickname. Тот описывает «кем игрок был
            //на момент события», и у смены ника его неоткуда взять кроме payload: сессии у события
            //нет, и сервис одно время подставлял туда УЖЕ НОВОЕ имя — получалось
            //«Новое имя теперь Новое имя». event.nickname остаётся запасным вариантом.
            const from = typeof event.payload["old"] === "string" && event.payload["old"] !== ""
                ? event.payload["old"]
                : event.nickname;
            const to = typeof event.payload["new"] === "string" ? event.payload["new"] : "";

            //Сообщение «X теперь X» бесполезно: если имена совпали, сказать нечего.
            return to === "" || from === to
                ? undefined
                : `${RENAME} <b>${escapeHtml(from)}</b> теперь <b>${escapeHtml(to)}</b>`;
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
