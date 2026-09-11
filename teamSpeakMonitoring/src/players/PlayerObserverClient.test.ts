import test from "node:test";
import assert from "node:assert/strict";
import {mock} from "node:test";
import {PlayerObserverClient} from "./PlayerObserverClient.js";
import {PlayerObserverUnavailable} from "./PlayerObserver.js";

const PROPERTIES = {baseUrl: "http://observer.test", apiToken: "secret", timeoutMs: 1_000};

//Подменяем fetch: проверяется разбор чужого JSON и обращение с отказами, сеть не нужна.
function stubFetch(response: {status?: number; body?: unknown} | Error): {calls: {url: string; init: RequestInit}[]} {
    const calls: {url: string; init: RequestInit}[] = [];

    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        calls.push({url, init});

        if (response instanceof Error) {
            throw response;
        }

        const status = response.status ?? 200;

        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => response.body,
        } as Response;
    });

    return {calls};
}

test.afterEach(() => {
    mock.restoreAll();
});

test("токен уходит заголовком, курсор и фильтр — в query", async () => {
    const {calls} = stubFetch({body: {events: [], next_after: 7}});

    await new PlayerObserverClient(PROPERTIES).events(7, [1, 2], 50);

    const call = calls[0];

    assert.ok(call);
    assert.ok(call.url.includes("after=7"), call.url);
    assert.ok(call.url.includes("player_ids=1%2C2"), call.url);
    assert.equal((call.init.headers as Record<string, string>)["Authorization"], "Bearer secret");
});

test("пустой фильтр игроков не передаётся вовсе", async () => {
    //Параметр с пустым значением означал бы «все игроки», и на чат без подписок приехала бы вся лента.
    const {calls} = stubFetch({body: {events: [], next_after: 0}});

    await new PlayerObserverClient(PROPERTIES).events(0, [], 50);

    assert.ok(!(calls[0]?.url ?? "").includes("player_ids"), calls[0]?.url);
});

test("событие разбирается целиком, время становится датой", async () => {
    stubFetch({
        body: {
            events: [{
                id: 42,
                type: "PLAYER_LEFT_SERVER",
                occurred_at: "2026-09-11T12:30:00Z",
                player_id: 7,
                nickname: "Salat",
                server_id: 3,
                server_name: "[RU] #1",
                session_id: 99,
                duration_seconds: 3_600,
                payload: {result: "JOINED_SERVER"},
                startup_replay: false,
                after_data_gap: true,
            }],
            next_after: 42,
        },
    });

    const page = await new PlayerObserverClient(PROPERTIES).events(0, [], 50);
    const [event] = page.events;

    assert.ok(event);
    assert.equal(event.id, 42);
    assert.equal(event.nickname, "Salat");
    assert.equal(event.durationSeconds, 3_600);
    assert.equal(event.afterDataGap, true);
    assert.equal(event.payload["result"], "JOINED_SERVER");
    assert.equal(event.occurredAt.toISOString(), "2026-09-11T12:30:00.000Z");
    assert.equal(page.nextAfter, 42);
});

test("битые записи пропускаются, а не роняют страницу", async () => {
    //Чужой сервис может измениться раньше нас; из-за одной непонятной строки терять остальные незачем.
    stubFetch({
        body: {
            events: [
                {id: "не число", type: "PLAYER_JOINED_SERVER", occurred_at: "2026-09-11T12:00:00Z", player_id: 7},
                {id: 43, type: "PLAYER_JOINED_SERVER", occurred_at: "не дата", player_id: 7},
                {id: 44, type: "PLAYER_JOINED_SERVER", occurred_at: "2026-09-11T12:00:00Z", player_id: 7},
            ],
            next_after: 44,
        },
    });

    const page = await new PlayerObserverClient(PROPERTIES).events(0, [], 50);

    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.id, 44);
});

test("игрок с местом и платформами", async () => {
    stubFetch({
        body: {
            fuzzy: true,
            players: [{
                player_id: 7,
                bohemia_user_id: "uuid",
                current_nickname: "Salat",
                aliases: ["Salat", "Salatik"],
                platforms: [{type: "PLATFORM_PC", id: "765", last_seen_at: "2026-09-11T12:00:00Z"}],
                first_seen_at: "2026-09-01T12:00:00Z",
                last_seen_at: "2026-09-11T12:00:00Z",
                online: {id: 3, name: "[RU] #1", host_address: "1.2.3.4:2001", since: "2026-09-11T11:00:00Z"},
                last_server: {id: 3, name: "[RU] #1", host_address: "1.2.3.4:2001"},
                sessions_total: 17,
            }],
        },
    });

    const result = await new PlayerObserverClient(PROPERTIES).searchPlayers("salat", 10);
    const [player] = result.players;

    assert.equal(result.fuzzy, true);
    assert.ok(player);
    assert.equal(player.online?.serverName, "[RU] #1");
    assert.equal(player.online?.since?.toISOString(), "2026-09-11T11:00:00.000Z");
    assert.equal(player.platforms[0]?.type, "PLATFORM_PC");
    assert.equal(player.sessionsTotal, 17);
});

test("404 на карточке игрока — это ответ «нет такого», а не отказ сервиса", async () => {
    stubFetch({status: 404});

    assert.equal(await new PlayerObserverClient(PROPERTIES).player(7), undefined);
});

test("сетевой отказ и код ошибки превращаются в PlayerObserverUnavailable", async () => {
    stubFetch(new Error("socket hang up"));

    await assert.rejects(
        () => new PlayerObserverClient(PROPERTIES).eventsHead(),
        (error: unknown) => error instanceof PlayerObserverUnavailable,
    );

    mock.restoreAll();
    stubFetch({status: 500});

    await assert.rejects(
        () => new PlayerObserverClient(PROPERTIES).eventsHead(),
        (error: unknown) => error instanceof PlayerObserverUnavailable,
    );
});

test("причина сетевого отказа попадает в сообщение", async () => {
    //Иначе в логе «Запрос не удался» одинаково выглядит и закрытый порт, и неразрешимое имя:
    //Node прячет настоящую ошибку в cause, а наружу отдаёт бесполезное «fetch failed».
    const failure = new TypeError("fetch failed");

    (failure as {cause?: unknown}).cause = Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:8081"), {
        code: "ECONNREFUSED",
    });
    stubFetch(failure);

    await assert.rejects(
        () => new PlayerObserverClient(PROPERTIES).eventsHead(),
        (error: unknown) => error instanceof PlayerObserverUnavailable && error.message.includes("ECONNREFUSED"),
    );
});

test("ненастроенный наблюдатель не ходит в сеть", async () => {
    const {calls} = stubFetch({body: {}});

    await assert.rejects(
        () => new PlayerObserverClient({...PROPERTIES, baseUrl: ""}).eventsHead(),
        (error: unknown) => error instanceof PlayerObserverUnavailable,
    );
    assert.equal(calls.length, 0);
});
