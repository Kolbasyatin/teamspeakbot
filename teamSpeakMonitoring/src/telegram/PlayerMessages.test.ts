import test from "node:test";
import assert from "node:assert/strict";
import type {ObservedPlayer, PlayerDossier, PlayerEvent, PlayerSession, SteamProfile} from "../players/PlayerObserver.js";
import {
    decodePlayerPick,
    decodePlayerWait,
    encodePlayerPick,
    encodePlayerWait,
    humanDuration,
    renderAliases,
    renderDossier,
    renderMatchNote,
    renderEvent,
    renderPlayerCard,
    renderSearchResults,
    renderSessions,
    renderSubscriptions,
} from "./PlayerMessages.js";

const NOW = new Date("2026-09-11T12:00:00Z");

function player(overrides: Partial<ObservedPlayer> = {}): ObservedPlayer {
    return {
        playerId: 7,
        bohemiaUserId: "uuid",
        currentNickname: "Salat",
        aliases: ["Salat"],
        platforms: [{type: "PLATFORM_PC", id: "765"}],
        firstSeenAt: new Date("2026-09-01T12:00:00Z"),
        lastSeenAt: new Date("2026-09-11T11:00:00Z"),
        online: undefined,
        lastServer: {serverId: 3, serverName: "[RU] #1", since: undefined},
        sessionsTotal: 17,
        ...overrides,
    };
}

function event(overrides: Partial<PlayerEvent> = {}): PlayerEvent {
    return {
        id: 1,
        type: "PLAYER_JOINED_SERVER",
        occurredAt: NOW,
        playerId: 7,
        nickname: "Salat",
        serverId: 3,
        serverName: "[RU] #1",
        durationSeconds: undefined,
        payload: {},
        afterDataGap: false,
        ...overrides,
    };
}

test("длительность читается человеком, а не в секундах", () => {
    assert.equal(humanDuration(30), "30 сек");
    assert.equal(humanDuration(600), "10 минут");
    assert.ok(humanDuration(4_320).includes("1 час"), humanDuration(4_320));
});

test("игрок онлайн и офлайн выглядят по-разному и показывают сервер", () => {
    const online = renderPlayerLineFor(player({
        online: {serverId: 3, serverName: "[RU] #1", since: new Date("2026-09-11T11:00:00Z")},
    }));
    const offline = renderPlayerLineFor(player());

    assert.ok(online.includes("[RU] #1"), online);
    assert.ok(offline.includes("офлайн"), offline);
    assert.ok(offline.includes("[RU] #1"), offline);
});

function renderPlayerLineFor(value: ObservedPlayer): string {
    return renderSubscriptions([value], [], NOW).text;
}

test("имя игрока экранируется для HTML", () => {
    //Незакрытый «<» в нике — это не кривая вёрстка, а отказ Telegram разобрать сообщение целиком.
    const {text} = renderSubscriptions([player({currentNickname: "<b>hax</b> & co"})], [], NOW);

    assert.ok(!text.includes("<b>hax"), text);
    assert.ok(text.includes("&lt;b&gt;hax"), text);
    assert.ok(text.includes("&amp; co"), text);
});

test("пустой список подписок подсказывает, что делать", () => {
    const {text} = renderSubscriptions([], [], NOW);

    assert.ok(text.includes("/watch"), text);
});

test("ожидаемые ники показываются отдельным разделом", () => {
    const {text} = renderSubscriptions([player()], ["Неуловимый"], NOW);

    assert.ok(text.includes("Ожидают появления"), text);
    assert.ok(text.includes("Неуловимый"), text);
});

test("карточка показывает прошлые ники, но не дублирует текущий", () => {
    const withHistory = renderPlayerCard(player({aliases: ["Salat", "Salatik"]}), false, NOW);
    const withoutHistory = renderPlayerCard(player({aliases: ["Salat"]}), false, NOW);

    assert.ok(withHistory.text.includes("Salatik"), withHistory.text);
    assert.ok(!withoutHistory.text.includes("Другие ники"), withoutHistory.text);
});

test("кнопка карточки противоположна текущему состоянию подписки", () => {
    assert.ok(JSON.stringify(renderPlayerCard(player(), false, NOW).keyboard.inline_keyboard).includes("Подписаться"));
    assert.ok(JSON.stringify(renderPlayerCard(player(), true, NOW).keyboard.inline_keyboard).includes("Отписаться"));
});

test("выбор игрока кодируется и разбирается обратно", () => {
    assert.equal(decodePlayerPick(encodePlayerPick(4812)), 4812);
    assert.equal(decodePlayerPick("s:r"), undefined, "чужой формат кнопки не должен разбираться");
    assert.equal(decodePlayerPick(""), undefined);
});

test("похожие совпадения помечаются как догадка", () => {
    const exact = renderSearchResults([player(), player({playerId: 8})], false, NOW);
    const fuzzy = renderSearchResults([player()], true, NOW);

    assert.ok(exact.text.includes("несколько игроков"), exact.text);
    assert.ok(fuzzy.text.includes("Точных совпадений нет"), fuzzy.text);
});

test("история визитов показывает чужой ник и разрыв данных", () => {
    const sessions: PlayerSession[] = [
        {
            serverId: 3,
            serverName: "[RU] #1",
            nickname: "OldName",
            firstSeenAt: new Date("2026-09-10T20:00:00Z"),
            lastSeenAt: new Date("2026-09-10T21:00:00Z"),
            endedAt: new Date("2026-09-10T21:01:00Z"),
            status: "CLOSED_DATA_GAP",
            durationSeconds: 3_600,
        },
    ];

    const text = renderSessions(player(), sessions, NOW);

    assert.ok(text.includes("OldName"), text);
    assert.ok(text.includes("данные прерывались"), text);
});

test("каждый тип события превращается в своё сообщение", () => {
    const joined = renderEvent(event());
    const left = renderEvent(event({type: "PLAYER_LEFT_SERVER", durationSeconds: 4_320}));
    const queued = renderEvent(event({type: "PLAYER_ENTERED_QUEUE"}));
    const joinedFromQueue = renderEvent(event({
        type: "PLAYER_LEFT_QUEUE",
        durationSeconds: 600,
        payload: {result: "JOINED_SERVER"},
    }));
    const leftQueue = renderEvent(event({type: "PLAYER_LEFT_QUEUE", payload: {result: "LEFT_QUEUE"}}));
    const renamed = renderEvent(event({type: "PLAYER_NICKNAME_CHANGED", payload: {old: "Salat", new: "Alicia"}}));

    assert.ok(joined?.includes("зашёл"), joined);
    assert.ok(left?.includes("провёл"), left);
    assert.ok(queued?.includes("очередь"), queued);
    assert.ok(joinedFromQueue?.includes("вошёл"), joinedFromQueue);
    assert.ok(leftQueue?.includes("ушёл из очереди"), leftQueue);
    assert.ok(renamed?.includes("Alicia"), renamed);
    assert.ok(renamed?.includes("Salat"), `старое имя должно быть в сообщении: ${renamed}`);
});

test("неизвестный тип события не превращается в сообщение", () => {
    //Сосед может завести новый тип раньше, чем бот научится его показывать. Строка «PLAYER_XXX»
    //в чате хуже тишины.
    assert.equal(renderEvent(event({type: "PLAYER_SOMETHING_NEW"})), undefined);
});

test("вход после разрыва наблюдения помечается как приблизительный", () => {
    const text = renderEvent(event({afterDataGap: true}));

    assert.ok(text?.includes("приблизительное"), text);
});

test("из списка похожих есть выход: кнопка ждать искомый ник", () => {
    //Без неё человек в тупике: похожие есть, значит ожидание ему не предложили,
    //а среди найденных нужного нет — он ещё не заходил на наблюдаемые серверы.
    const {text, keyboard} = renderSearchResults([player(), player({playerId: 8})], true, NOW, "Добрый Фей");
    const buttons = JSON.stringify(keyboard.inline_keyboard);

    assert.ok(buttons.includes("Ждать"), buttons);
    assert.ok(buttons.includes("pw:Добрый Фей"), buttons);
    assert.ok(text.includes("Никого из них"), text);
});

test("без искомого ника кнопки ожидания нет", () => {
    //Так список показывается при отписке: там выбирают среди своих подписок, ждать нечего.
    const {text, keyboard} = renderSearchResults([player()], false, NOW);

    assert.ok(!JSON.stringify(keyboard.inline_keyboard).includes("Ждать"));
    assert.ok(!text.includes("Никого из них"));
});

test("слишком длинный ник не уезжает в кнопку, а предлагается командой", () => {
    //callback_data ограничена 64 байтами, кириллица по два байта на символ. Молча обрезать ник
    //нельзя: ждали бы не того человека.
    const long = "Очень длинный ник который заведомо не помещается в кнопку";

    assert.equal(encodePlayerWait(long), undefined);

    const {text, keyboard} = renderSearchResults([player()], false, NOW, long);

    assert.ok(!JSON.stringify(keyboard.inline_keyboard).includes("Ждать"));
    assert.ok(text.includes(`/wait ${long}`), text);
});

test("ник кнопки ожидания кодируется и разбирается обратно", () => {
    const data = encodePlayerWait("Добрый Фей");

    assert.ok(data);
    assert.equal(decodePlayerWait(data), "Добрый Фей");
    assert.equal(decodePlayerWait("p:42"), undefined, "чужой формат кнопки не должен разбираться");
    assert.equal(decodePlayerWait("pw:"), undefined, "пустой ник — не ожидание");
});

test("переименование показывает оба имени, даже если сервис прислал новое в nickname", () => {
    //Было именно так: у события смены ника нет сессии, и сервис подставлял в nickname текущее
    //(уже новое) имя. Получалось «Новое имя теперь Новое имя». Оба имени есть в payload,
    //поэтому берём их оттуда.
    const text = renderEvent(event({
        type: "PLAYER_NICKNAME_CHANGED",
        nickname: "Alicia",
        payload: {old: "Salat", new: "Alicia"},
    }));

    assert.ok(text?.includes("Salat"), text);
    assert.ok(text?.includes("Alicia"), text);
    assert.ok(text);
    assert.ok(text.indexOf("Salat") < text.indexOf("Alicia"), `старое имя должно идти первым: ${text}`);
});

test("переименование в то же самое имя не порождает сообщения", () => {
    assert.equal(
        renderEvent(event({type: "PLAYER_NICKNAME_CHANGED", payload: {old: "Salat", new: "Salat"}})),
        undefined,
    );
});

test("без old в payload берётся ник события", () => {
    //Запасной путь на случай старой версии сервиса, которая old не присылала.
    const text = renderEvent(event({
        type: "PLAYER_NICKNAME_CHANGED",
        nickname: "Старый",
        payload: {new: "Новый"},
    }));

    assert.ok(text?.includes("Старый"), text);
    assert.ok(text?.includes("Новый"), text);
});

test("все ники: текущий в заголовке, прежние отдельной строкой", () => {
    const text = renderAliases([player({aliases: ["Salat", "Добрый Фей", "SaLaT"]})], false, "Добрый", NOW);

    assert.match(text, /Salat/);
    assert.match(text, /Прежние ники \(2\)/);
    assert.match(text, /Добрый Фей/);
    assert.match(text, /SaLaT/);
    //Текущий ник уже назван в строке игрока — в перечне прежних его быть не должно.
    assert.equal(text.match(/Salat/g)?.length, 1);
});

test("все ники: игрок без переименований", () => {
    const text = renderAliases([player()], false, "Salat", NOW);

    assert.match(text, /Других ников не было/);
});

test("все ники: при неточном совпадении список подписан как похожие", () => {
    const text = renderAliases([player({aliases: ["Salat"]})], true, "Salad", NOW);

    assert.match(text, /Точного совпадения с «Salad» нет/);
});

test("все ники: нескольких игроков нумеруем", () => {
    const text = renderAliases(
        [player({playerId: 1, currentNickname: "Alpha", aliases: ["Alpha"]}),
         player({playerId: 2, currentNickname: "Alpha2", aliases: ["Alpha2"]})],
        false,
        "Alpha",
        NOW,
    );

    assert.match(text, /1\. /);
    assert.match(text, /2\. /);
});

test("все ники: ничего не нашлось", () => {
    const text = renderAliases([], false, "Никого", NOW);

    assert.match(text, /мы не видели/);
});

test("все ники: html в никах экранируется", () => {
    const text = renderAliases([player({aliases: ["Salat", "<b>hack</b>"]})], false, "Salat", NOW);

    assert.match(text, /&lt;b&gt;hack&lt;\/b&gt;/);
});

function steamProfile(overrides: Partial<SteamProfile> = {}): SteamProfile {
    return {
        personaName: "Шустрый",
        realName: "",
        profileUrl: "https://steamcommunity.com/profiles/76561198884181842/",
        countryCode: "",
        createdAt: new Date("2019-01-05T00:00:00Z"),
        visibility: 3,
        vacBanned: false,
        vacBanCount: 0,
        gameBanCount: 0,
        reforgerMinutes: 51648,
        reforgerMinutes2w: 1230,
        gamesVisible: true,
        friendsVisible: true,
        updatedAt: new Date("2026-09-11T11:00:00Z"),
        ...overrides,
    };
}

function dossier(overrides: Partial<PlayerDossier> = {}): PlayerDossier {
    return {
        playerId: 7,
        nickname: "",
        steamId: "76561198884181842",
        profile: steamProfile(),
        lastError: "",
        friends: [],
        friendsKnown: 0,
        ...overrides,
    };
}

test("досье: налёт показывается в часах", () => {
    const text = renderDossier(dossier(), NOW, player());

    assert.match(text, /861 ч/);
    assert.match(text, /за 2 недели 21 ч/);
    assert.match(text, /Баны: чисто/);
});

test("досье: скрытая библиотека не превращается в ноль часов", () => {
    //Ноль часов и «мы не знаем» — разные утверждения, и второе нельзя показывать первым.
    const text = renderDossier(dossier({
        profile: steamProfile({gamesVisible: false, reforgerMinutes: undefined, reforgerMinutes2w: undefined}),
    }), NOW, player());

    assert.match(text, /библиотека игр скрыта/);
    assert.doesNotMatch(text, /0 ч/);
});

test("досье: несобранные баны не показываются как «чисто»", () => {
    const text = renderDossier(dossier({
        profile: steamProfile({vacBanned: undefined, vacBanCount: undefined, gameBanCount: undefined}),
    }), NOW, player());

    assert.doesNotMatch(text, /Баны/);
});

test("досье: бан показывается заметно", () => {
    const text = renderDossier(dossier({
        profile: steamProfile({vacBanned: true, vacBanCount: 2}),
    }), NOW, player());

    assert.match(text, /⛔/);
    assert.match(text, /VAC 2/);
});

test("досье: из друзей выделяются те, кого мы видели у себя", () => {
    const text = renderDossier(dossier({
        friends: [
            {steamId: "1", playerId: 11, nickname: "Сосед", lastSeenAt: new Date("2026-09-11T10:00:00Z")},
            {steamId: "2", nickname: ""},
            {steamId: "3", nickname: ""},
        ],
        friendsKnown: 1,
    }), NOW, player());

    assert.match(text, /Друзья: 3, из них у нас замечены 1/);
    assert.match(text, /Сосед/);
});

test("досье: скрытый список друзей так и называется", () => {
    const text = renderDossier(dossier({
        profile: steamProfile({friendsVisible: false}),
    }), NOW, player());

    assert.match(text, /список скрыт/);
});

test("подписки: под списком есть кнопки досье", () => {
    const {keyboard} = renderSubscriptions([player({playerId: 7, currentNickname: "Salat"})], [], NOW);
    const buttons = keyboard.inline_keyboard.flat();

    assert.equal(buttons.length, 1);
    assert.match(String(buttons[0]?.text), /Salat/);
    assert.equal((buttons[0] as {callback_data?: string}).callback_data, "pi:7");
});

// Регрессия. Пока профиль был обязательным полем, несобранные данные приезжали нулевой
// структурой, и досье бодро сообщало «библиотека игр скрыта» и «данные собраны 2025 лет назад».
test("досье: несобранные данные не выдаются за скрытые", () => {
    const text = renderDossier(dossier({profile: undefined, lastError: ""}), NOW, player());

    assert.match(text, /ещё не собраны/);
    assert.doesNotMatch(text, /скрыт/);
    assert.doesNotMatch(text, /собраны \d+ лет/);
});

test("досье: причина неудачи показывается человеку", () => {
    const text = renderDossier(dossier({
        profile: undefined,
        lastError: "steam: gateway returned 503",
    }), NOW, player());

    assert.match(text, /503/);
});

// Регрессия. Список тёзок должен предлагать действие той команды, которая его открыла.
test("список тёзок для досье не подписывает и не предлагает ждать", () => {
    const {text, keyboard} = renderSearchResults(
        [player({playerId: 1, currentNickname: "jimenezalex8898"}), player({playerId: 2, currentNickname: "Zalex"})],
        false,
        NOW,
        "Zalex",
        "info",
    );

    const buttons = keyboard.inline_keyboard.flat().map(b => (b as {callback_data?: string}).callback_data);

    assert.deepEqual(buttons, ["pi:1", "pi:2"]);
    assert.match(text, /чьё досье показать/);
    //«Ждать ник» здесь бессмысленно: человек просил показать, а не следить. Раньше кнопка
    //появлялась даже когда нужный игрок в списке уже был.
    assert.doesNotMatch(text, /Ждать/);
});

test("список тёзок для подписки по-прежнему подписывает и предлагает ждать", () => {
    const {text, keyboard} = renderSearchResults([player({playerId: 1})], false, NOW, "Zalex", "watch");
    const buttons = keyboard.inline_keyboard.flat().map(b => (b as {callback_data?: string}).callback_data);

    assert.equal(buttons[0], "p:1");
    assert.match(text, /за кем следить/);
    assert.ok(buttons.some(data => data?.startsWith("pw:")), "кнопка ожидания на месте");
});

test("досье: ссылка и SteamID есть даже когда данные не собраны", () => {
    //Когда собрать не удалось, ссылка полезнее всего: человек откроет профиль сам.
    //SteamID мы знаем из своих наблюдений, Valve для него не нужна.
    const text = renderDossier(dossier({profile: undefined, lastError: ""}), NOW, player());

    assert.match(text, /href="https:\/\/steamcommunity\.com\/profiles\/76561198884181842"/);
    assert.match(text, /<code>76561198884181842<\/code>/);
});

test("досье: ссылка Valve имеет приоритет над собранной вручную", () => {
    const text = renderDossier(dossier({
        profile: steamProfile({profileUrl: "https://steamcommunity.com/id/shustry/"}),
    }), NOW, player());

    assert.match(text, /href="https:\/\/steamcommunity\.com\/id\/shustry\/"/);
    assert.match(text, /<code>76561198884181842<\/code>/);
});

test("досье без SteamID не рисует пустую ссылку", () => {
    const text = renderDossier(dossier({steamId: "", profile: undefined}), NOW, player());

    assert.doesNotMatch(text, /href=/);
    assert.doesNotMatch(text, /SteamID/);
});

test("полные тёзки получают различающие признаки, одиночки — нет", () => {
    const twins = renderSearchResults([
        player({playerId: 1, currentNickname: "Zalex", platforms: [{type: "PLATFORM_PC", id: "76561198000001111"}], sessionsTotal: 40}),
        player({playerId: 2, currentNickname: "Zalex", platforms: [{type: "PLATFORM_PC", id: "76561198000002222"}], sessionsTotal: 3}),
    ], false, NOW, "Zalex", "info");

    //Обоим дописали, чем они отличаются: иначе строки совпали бы до буквы.
    assert.match(twins.text, /Steam …1111/);
    assert.match(twins.text, /Steam …2222/);
    assert.match(twins.text, /визитов 40/);
    assert.match(twins.text, /визитов 3/);

    const distinct = renderSearchResults([
        player({playerId: 1, currentNickname: "Zalex"}),
        player({playerId: 2, currentNickname: "jimenezalex8898"}),
    ], false, NOW, "Zalex", "info");

    //Разные ники и так различимы — лишние строки только мешали бы.
    assert.doesNotMatch(distinct.text, /визитов/);
});

test("тёзки без Steam различаются платформой", () => {
    const {text} = renderSearchResults([
        player({playerId: 1, currentNickname: "Зет", platforms: [{type: "PLATFORM_PSN", id: "1"}]}),
        player({playerId: 2, currentNickname: "Зет", platforms: [{type: "PLATFORM_XBL", id: "2"}]}),
    ], false, NOW, "Зет", "card");

    assert.match(text, /PlayStation|PSN/);
    assert.match(text, /Xbox|XBL/);
});

test("совпадение по прежнему нику объясняется", () => {
    //Спросил про Zalex — показали Aidaho. Без пояснения это выглядит как ошибка бота.
    const note = renderMatchNote(player({currentNickname: "Aidaho", aliases: ["Aidaho", "Zalex"]}), "Zalex");

    assert.ok(note);
    assert.match(note, /прежнему нику «Zalex»/);
    assert.match(note, /сейчас он Aidaho/);
});

test("совпадение по текущему нику не объясняется", () => {
    assert.equal(renderMatchNote(player({currentNickname: "Salat", aliases: ["Salat", "Zalex"]}), "Salat"), undefined);
    //Регистр не важен: поиск у наблюдателя тоже регистронезависим.
    assert.equal(renderMatchNote(player({currentNickname: "Salat", aliases: ["Salat"]}), "salat"), undefined);
    //Частичное совпадение с текущим ником — тоже не повод пояснять.
    assert.equal(renderMatchNote(player({currentNickname: "Salatik", aliases: ["Salatik"]}), "Salat"), undefined);
});

test("поиск по id и пустой запрос ничего не поясняют", () => {
    const value = player({currentNickname: "Aidaho", aliases: ["Aidaho", "Zalex"]});

    assert.equal(renderMatchNote(value, "4812"), undefined);
    assert.equal(renderMatchNote(value, ""), undefined);
});

test("пояснение экранирует ники", () => {
    const note = renderMatchNote(player({currentNickname: "<b>now</b>", aliases: ["<b>now</b>", "<i>was</i>"]}), "was");

    assert.ok(note);
    assert.match(note, /&lt;i&gt;was&lt;\/i&gt;/);
    assert.doesNotMatch(note, /<b>now<\/b>/);
});

test("отслеживаемые тёзки идут первыми и помечаются", () => {
    //Популярный ник встречается у нескольких людей, и почти всегда нужен тот, за кем следят.
    const {text, keyboard} = renderSearchResults(
        [
            player({playerId: 1, currentNickname: "Winnie"}),
            player({playerId: 2, currentNickname: "Winnie"}),
            player({playerId: 3, currentNickname: "Winnie"}),
        ],
        false,
        NOW,
        "Winnie",
        "info",
        new Set([3]),
    );

    const buttons = keyboard.inline_keyboard.flat().map(b => (b as {callback_data?: string}).callback_data);

    const labels = keyboard.inline_keyboard.flat().map(b => String(b.text));

    assert.equal(buttons[0], "pi:3", "подписка должна быть первой");
    assert.equal(labels[0], "⭐ 1. Winnie", "подпись кнопки помечена и читается");
    assert.equal(labels[1], "2. Winnie");
    assert.deepEqual(buttons.slice(1), ["pi:1", "pi:2"], "остальные сохраняют исходный порядок");
    assert.match(text, /1\. .*⭐ следим/);
    //Пометка только у своего: иначе она ничего не различает.
    assert.equal(text.match(/⭐ следим/g)?.length, 1);
});

test("без подписок список не меняет порядок и ничего не помечает", () => {
    const {text, keyboard} = renderSearchResults(
        [player({playerId: 1, currentNickname: "Winnie"}), player({playerId: 2, currentNickname: "Winnie"})],
        false,
        NOW,
        "Winnie",
        "info",
    );

    const buttons = keyboard.inline_keyboard.flat().map(b => (b as {callback_data?: string}).callback_data);

    assert.deepEqual(buttons, ["pi:1", "pi:2"]);
    assert.doesNotMatch(text, /следим/);
});

test("досье по SteamID без нашего игрока: заголовок из ника в Steam", () => {
    //Аккаунта может не быть в Arma вовсе — Steam про нашу игру ничего не знает.
    const text = renderDossier(dossier({playerId: 0, nickname: "", profile: steamProfile({personaName: "everything"})}), NOW);

    assert.match(text, /<b>everything<\/b> — досье Steam/);
    assert.doesNotMatch(text, /У нас известен как/);
});

test("досье по SteamID: без данных заголовок из самого id", () => {
    const text = renderDossier(dossier({playerId: 0, nickname: "", profile: undefined}), NOW);

    assert.match(text, /<b>76561198884181842<\/b> — досье Steam/);
});

test("досье по SteamID: знакомый аккаунт связывается с нашим игроком", () => {
    //Ради этой связки обратный поиск и нужен: по id узнать, кто это у нас.
    const text = renderDossier(dossier({playerId: 42, nickname: "Salat"}), NOW);

    assert.match(text, /<b>Salat<\/b> — досье Steam/);
    assert.match(text, /У нас известен как <b>Salat<\/b>/);
});

test("досье по игроку не повторяет связку с самим собой", () => {
    const text = renderDossier(dossier({playerId: 42, nickname: "Salat"}), NOW, player({currentNickname: "Salat"}));

    assert.doesNotMatch(text, /У нас известен как/);
});
