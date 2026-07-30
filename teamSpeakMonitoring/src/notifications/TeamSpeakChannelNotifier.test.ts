import test from "node:test";
import assert from "node:assert/strict";
import {TeamSpeakChannelNotifier, type ChannelDescriptionEditor} from "./TeamSpeakChannelNotifier.js";
import type {NotificationEventOf} from "./events.js";

const viewChanged: NotificationEventOf<"statusViewChanged"> = {
    type: "statusViewChanged",
    view: [
        {id: 1, name: "Server one", status: "online", players: 10, maxPlayers: 64},
        {id: 2, name: "Server two", status: "offline", players: undefined, maxPlayers: undefined},
    ],
};

interface RecordingEditor extends ChannelDescriptionEditor {
    calls: Array<{channelName: string; description: string}>;
}

function createEditor(options: {failOn?: string} = {}): RecordingEditor {
    return {
        calls: [],
        async editChannelDescription(channelName: string, description: string): Promise<void> {
            this.calls.push({channelName, description});
            if (options.failOn === channelName) {
                throw new Error(`Channel not found: ${channelName}`);
            }
        },
    } as RecordingEditor;
}

test("описание пишется во все настроенные каналы", async () => {
    const editor = createEditor();
    const notifier = new TeamSpeakChannelNotifier(editor, ["ServerInfo", "ServerInfoBackup"]);

    await notifier.notify(viewChanged);

    assert.deepEqual(
        editor.calls.map(call => call.channelName),
        ["ServerInfo", "ServerInfoBackup"],
    );
    //Оба канала получают одинаковый текст, отрендеренный один раз.
    assert.equal(editor.calls[0]?.description, editor.calls[1]?.description);
});

test("в описание попадают имена и счёт игроков всех серверов", async () => {
    const editor = createEditor();
    const notifier = new TeamSpeakChannelNotifier(editor, ["ServerInfo"]);

    await notifier.notify(viewChanged);
    const description = editor.calls[0]?.description ?? "";

    assert.match(description, /Server one/);
    assert.match(description, /10\/64/);
    assert.match(description, /Server two/);
    assert.match(description, /offline/);
});

//Тест «события других типов игнорируются» удалён: нотифаер типизирован под statusViewChanged,
//чужое событие в него теперь не передать — это ошибка компиляции, а не поведение в рантайме.
//Проверять рантайм-тестом нечего, а @ts-expect-error здесь был бы бесполезен: тесты не входят
//в tsc (см. AGENTS.md, п. 22 долга).

test("отказ одного канала не мешает попытке обновить остальные, но виден снаружи", async () => {
    //Итерация 2: раньше здесь был allSettled, и отказ правки канала пропадал бесследно.
    const editor = createEditor({failOn: "Broken"});
    const notifier = new TeamSpeakChannelNotifier(editor, ["Broken", "ServerInfo"]);

    await assert.rejects(
        () => notifier.notify(viewChanged),
        /Channel not found: Broken/,
        "отказ пробрасывается наружу, чтобы NotificationDispatcher его залогировал",
    );

    assert.deepEqual(
        editor.calls.map(call => call.channelName),
        ["Broken", "ServerInfo"],
        "исправный канал всё равно был обновлён",
    );
});

test("пустой список каналов не приводит к обращениям", async () => {
    const editor = createEditor();
    const notifier = new TeamSpeakChannelNotifier(editor, []);

    await notifier.notify(viewChanged);

    assert.deepEqual(editor.calls, []);
});
