import test from "node:test";
import assert from "node:assert/strict";
import {ChannelDescriptionRenderer} from "./ChannelDescriptionRenderer.js";
import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";
import {snapshotFixture} from "../test/serverFixtures.js";

//Эти тесты не про красоту текста, а про связь между ТЕМ, ЧТО ВИДИТ ЧЕЛОВЕК, и КЛЮЧОМ, по которому
//ChangesOnlyNotifier решает, лезть ли в TeamSpeak. Правило: изменилось видимое — обязан измениться
//ключ, и наоборот. Комментарии его описывают, а красное здесь — единственное, что о нарушении
//сообщит. Ловят они конкретную ошибку: добавить строку в render() мимо renderBody(), после чего
//табло замолчит при изменениях, ничего при этом не сломав.

const TIMESTAMP_LINE = /\n\nОбновлено: \d{2}:\d{2}:\d{2}$/;

function board(): ServerProbeSnapshot[] {
    return [
        snapshotFixture({id: 1, name: "First", status: "online", players: 10}),
        snapshotFixture({id: 2, name: "Second", status: "offline"}),
    ];
}

test("текст описания = ключ + отметка времени, и больше ничего", () => {
    //Самая прямая запись инварианта. Появится в render() что-то, чего нет в renderBody(),
    //— этот тест покраснеет сразу, ещё до того как расхождение доедет до канала.
    const snapshots = board();

    const text = ChannelDescriptionRenderer.render(snapshots);
    const key = ChannelDescriptionRenderer.renderBody(snapshots);

    assert.match(text, TIMESTAMP_LINE, "отметка времени на месте");
    assert.equal(text.replace(TIMESTAMP_LINE, ""), key, "всё остальное в тексте есть в ключе");
});

test("ключ не зависит от времени", () => {
    //Иначе дедупликация не срабатывала бы никогда и обёртка стала бы дорогим no-op.
    const snapshots = board();

    assert.equal(
        ChannelDescriptionRenderer.renderBody(snapshots),
        ChannelDescriptionRenderer.renderBody(snapshots),
    );
});

test("любое видимое изменение меняет ключ", () => {
    //Ключ грубее нужного — обновления теряются: в канале висит устаревшее, а мы молчим,
    //потому что «уже это отправляли».
    const variants: Array<[string, ServerProbeSnapshot[]]> = [
        ["исходное", [snapshotFixture({id: 1, name: "First", status: "online", players: 10})]],
        ["другое число игроков", [snapshotFixture({id: 1, name: "First", status: "online", players: 11})]],
        ["другой максимум", [snapshotFixture({id: 1, name: "First", status: "online", players: 10, maxPlayers: 32})]],
        ["другой статус", [snapshotFixture({id: 1, name: "First", status: "offline", players: 10})]],
        ["данных нет", [snapshotFixture({id: 1, name: "First", status: "online"})]],
        ["другое имя", [snapshotFixture({id: 1, name: "Renamed", status: "online", players: 10})]],
        ["добавился сервер", board()],
        ["серверов нет вовсе", []],
    ];

    const keys = new Map<string, string>();

    for (const [name, snapshots] of variants) {
        const key = ChannelDescriptionRenderer.renderBody(snapshots);
        const collision = keys.get(key);

        assert.equal(collision, undefined, `«${name}» и «${collision}» дают один ключ, различить их нельзя`);
        keys.set(key, name);
    }
});

test("изменение, невидимое в описании, ключ не меняет", () => {
    //Обратная сторона правила: ключ тоньше нужного — записи в TeamSpeak на каждом опросе.
    //failedChecks и statusSince в описание не попадают, значит и в ключе им делать нечего.
    const base = snapshotFixture({id: 1, name: "First", status: "online", players: 10});
    const noisy: ServerProbeSnapshot = {...base, failedChecks: 2, statusSince: new Date(777)};

    assert.equal(
        ChannelDescriptionRenderer.renderBody([noisy]),
        ChannelDescriptionRenderer.renderBody([base]),
    );
});

test("очередь видна и различима в ключе, нулевая и неизвестная не показываются", () => {
    const withQueue = snapshotFixture({id: 1, name: "First", status: "online", players: 128, maxPlayers: 128, info: {queueSize: 7}});
    const emptyQueue = snapshotFixture({id: 1, name: "First", status: "online", players: 128, maxPlayers: 128, info: {queueSize: 0}});
    const unknownQueue = snapshotFixture({id: 1, name: "First", status: "online", players: 128, maxPlayers: 128});

    assert.match(ChannelDescriptionRenderer.renderBody([withQueue]), /128\/128\[\/color\] \[color=#FFD166\]\+7 в очереди\[\/color\]$/);
    //«+0 в очереди» у полного сервера не сообщает ничего; неизвестная очередь выглядит так же.
    assert.equal(ChannelDescriptionRenderer.renderBody([emptyQueue]), ChannelDescriptionRenderer.renderBody([unknownQueue]));
    assert.doesNotMatch(ChannelDescriptionRenderer.renderBody([emptyQueue]), /очеред/);
});

test("свежесть данных в описание не попадает", () => {
    //Возраст меняется каждую секунду — попади он в ключ, табло переписывалось бы на каждом тике.
    const fresh = snapshotFixture({id: 1, name: "First", status: "online", players: 10, info: {queueSize: 2, dataUpdatedAt: 1_000}});
    const stale = snapshotFixture({id: 1, name: "First", status: "online", players: 10, info: {queueSize: 2, dataUpdatedAt: 999_000}});

    assert.equal(ChannelDescriptionRenderer.renderBody([fresh]), ChannelDescriptionRenderer.renderBody([stale]));
});
