import test from "node:test";
import assert from "node:assert/strict";
import type {Bot} from "grammy";
import {TelegramSender} from "./TelegramSender.js";

//Текст-сигнал: на нём заглушка не отвечает, пока тест сам не отпустит. Зависание привязано
//к тексту, а не к «следующей по счёту» отправке: порядок, в котором два параллельных вызова
//доходят до sendMessage, зависит от числа микрозадач в каждом и не гарантирован.
const HANGING_TEXT = "зависшее";

interface SenderHarness {
    sender: TelegramSender;
    sent: {chatId: number | string; text: string; at: number}[];
    slept: number[];
    advance: (ms: number) => void;
    //Отпустить зависшую отправку. Незавершённый промис держит раннер тестов, поэтому
    //тест обязан это сделать сам.
    release: () => void;
}

//Настоящий Bot не нужен: проверяется только разводка отправок по времени.
//Часы и ожидание подменены, иначе тест зависел бы от реального времени и был бы медленным.
function createSender(): SenderHarness {
    let clock = 1_000;
    const sent: {chatId: number | string; text: string; at: number}[] = [];
    const slept: number[] = [];
    let releaseHung: () => void = () => undefined;

    const bot = {
        api: {
            sendMessage: async (chatId: number | string, text: string): Promise<void> => {
                sent.push({chatId, text, at: clock});

                if (text === HANGING_TEXT) {
                    await new Promise<void>(resolve => {
                        releaseHung = resolve;
                    });
                }
            },
        },
    } as unknown as Bot;

    const sender = new TelegramSender(
        bot,
        () => clock,
        async (delayMs: number): Promise<void> => {
            slept.push(delayMs);
            clock += delayMs;
        },
    );

    return {
        sender,
        sent,
        slept,
        advance: (ms: number): void => {
            clock += ms;
        },
        release: (): void => {
            releaseHung();
        },
    };
}

test("первая отправка уходит сразу, без ожидания", async () => {
    const {sender, sent, slept} = createSender();

    await sender.send(1, "привет");

    assert.equal(sent.length, 1);
    assert.deepEqual(slept, []);
});

test("подряд идущие отправки разводятся по времени", async () => {
    //Массовый заход на сервер порождает десятки уведомлений одним тиком. Без разводки
    //Bot API отвечает 429, и часть сообщений теряется.
    const {sender, sent, slept} = createSender();

    await sender.send(1, "первое");
    await sender.send(2, "второе");
    await sender.send(3, "третье");

    assert.equal(sent.length, 3);
    assert.equal(slept.length, 2, "второе и третье сообщения должны были подождать свой слот");
    assert.ok(slept.every(delay => delay > 0), `ожидания должны быть ненулевыми: ${slept.join(", ")}`);
    assert.ok(
        (sent[1]?.at ?? 0) > (sent[0]?.at ?? 0) && (sent[2]?.at ?? 0) > (sent[1]?.at ?? 0),
        "каждая следующая отправка стартует позже предыдущей",
    );
});

test("пауза между отправками освобождает слот — ждать не нужно", async () => {
    const {sender, slept, advance} = createSender();

    await sender.send(1, "первое");
    advance(5_000);
    await sender.send(2, "второе");

    assert.deepEqual(slept, [], "после паузы слот свободен и ожидание не требуется");
});

test("зависшая отправка не держит очередь", async () => {
    //Иначе один медленный запрос останавливал бы и уведомления мониторинга: экземпляр один на всех.
    const {sender, sent, release} = createSender();

    const hung = sender.send(1, HANGING_TEXT);

    await sender.send(2, "следующее");

    assert.equal(sent.length, 2, "вторая отправка должна была уйти, не дожидаясь первой");

    release();
    await hung;
});
