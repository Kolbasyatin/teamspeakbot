import test from "node:test";
import assert from "node:assert/strict";
import {TelegramStatusNotifier, type MessageSender} from "./TelegramStatusNotifier.js";
import type {NotificationEventOf} from "./events.js";
import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";
import {serverConfigFixture} from "../test/serverFixtures.js";

//У Telegram-нотифаеров тестов не было вовсе: они зависели от конкретного TelegramSender,
//а тот тянет grammy. Узкий интерфейс MessageSender сделал их проверяемыми.

function snapshot(name: string): ServerProbeSnapshot {
    return {
        config: serverConfigFixture({name}),
        status: "online",
        failedChecks: 0,
        currentInfo: undefined,
        statusSince: new Date(0),
    };
}

const serverOnline: NotificationEventOf<"serverOnline"> = {
    type: "serverOnline",
    snapshot: snapshot("ARMA-RUSSIAN"),
};

const serverOffline: NotificationEventOf<"serverOffline"> = {
    type: "serverOffline",
    snapshot: snapshot("ARMA-RUSSIAN"),
};

interface RecordingSender extends MessageSender {
    sent: string[];
}

function createSender(options: {failWith?: Error} = {}): RecordingSender {
    return {
        sent: [],
        async send(text: string): Promise<void> {
            this.sent.push(text);
            if (options.failWith) {
                throw options.failWith;
            }
        },
    } as RecordingSender;
}

test("на serverOnline отправляется текст из таблицы", async () => {
    const sender = createSender();

    await new TelegramStatusNotifier(sender).notify(serverOnline);

    assert.deepEqual(sender.sent, ["ARMA-RUSSIAN is online"]);
});

test("на serverOffline отправляется текст из таблицы", async () => {
    const sender = createSender();

    await new TelegramStatusNotifier(sender).notify(serverOffline);

    assert.deepEqual(sender.sent, ["ARMA-RUSSIAN is offline"]);
});

test("один экземпляр обслуживает оба события", async () => {
    //Смысл слияния двух классов в один: расширение идёт по строкам таблицы, а не по классам.
    const sender = createSender();
    const notifier = new TelegramStatusNotifier(sender);

    await notifier.notify(serverOnline);
    await notifier.notify(serverOffline);

    assert.deepEqual(sender.sent, ["ARMA-RUSSIAN is online", "ARMA-RUSSIAN is offline"]);
});

test("имя сервера берётся из конфигурации снапшота", async () => {
    const sender = createSender();

    await new TelegramStatusNotifier(sender).notify({
        type: "serverOnline",
        snapshot: snapshot("#5 PLANESET"),
    });

    assert.deepEqual(sender.sent, ["#5 PLANESET is online"]);
});

test("отказ транспорта пробрасывается наружу, чтобы диспетчер его залогировал", async () => {
    const failure = new Error("Telegram API 429");
    const sender = createSender({failWith: failure});

    await assert.rejects(
        () => new TelegramStatusNotifier(sender).notify(serverOnline),
        /Telegram API 429/,
    );
});
