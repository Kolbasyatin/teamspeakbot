import test from "node:test";
import assert from "node:assert/strict";
import {LatestOnlyNotifier} from "./LatestOnlyNotifier.js";
import type {Notifier, NotificationEventOf} from "./events.js";
import type {ServerDescriptionView} from "../monitoring/ServerMonitor.js";
import type {Logger} from "pino";

function viewEvent(players: number): NotificationEventOf<"statusViewChanged"> {
    const view: ServerDescriptionView[] = [
        {id: 1, name: "Test server", status: "online", players, maxPlayers: 64},
    ];
    return {type: "statusViewChanged", view};
}

//Управляемый нотифаер: каждая доставка висит, пока её не отпустят release().
//Так наложение событий воспроизводится без таймеров и без гонок.
interface ControllableNotifier extends Notifier<"statusViewChanged"> {
    delivered: number[];
    release(): void;
    failNext(error: Error): void;
}

function createControllable(): ControllableNotifier {
    let unblock: (() => void) | undefined;
    let failWith: Error | undefined;

    return {
        delivered: [] as number[],
        release(): void {
            unblock?.();
            unblock = undefined;
        },
        failNext(error: Error): void {
            failWith = error;
        },
        async notify(event: NotificationEventOf<"statusViewChanged">): Promise<void> {
            await new Promise<void>(resolve => {
                unblock = resolve;
            });

            if (failWith) {
                const error = failWith;
                failWith = undefined;
                throw error;
            }

            this.delivered.push(event.view[0]?.players ?? -1);
        },
    } as ControllableNotifier;
}

function createLogger(): {logger: Logger; warnings: Array<{context: Record<string, unknown>; message: string}>} {
    const warnings: Array<{context: Record<string, unknown>; message: string}> = [];

    const logger = {
        debug: () => {},
        info: () => {},
        error: () => {},
        warn: (context: Record<string, unknown>, message: string) => warnings.push({context, message}),
    } as unknown as Logger;

    return {logger, warnings};
}

//Отдаёт управление event loop, чтобы уже начатые промисы продвинулись.
function flush(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

test("одиночное событие доставляется как есть", async () => {
    const inner = createControllable();
    const notifier = new LatestOnlyNotifier(inner, createLogger().logger);

    const delivery = notifier.notify(viewEvent(10));
    await flush();
    inner.release();
    await delivery;

    assert.deepEqual(inner.delivered, [10]);
});

test("пока доставка идёт, промежуточные события выбрасываются — доходит только последнее", async () => {
    const inner = createControllable();
    const notifier = new LatestOnlyNotifier(inner, createLogger().logger);

    //Первое событие занимает доставку и висит в ней.
    const drained = notifier.notify(viewEvent(10));
    await flush();

    //Пока доставка не отпущена, приходят ещё три.
    void notifier.notify(viewEvent(11));
    void notifier.notify(viewEvent(12));
    void notifier.notify(viewEvent(13));
    await flush();

    assert.deepEqual(inner.delivered, [], "первая доставка ещё не завершена");

    inner.release();     //завершилась доставка 10, цикл забирает накопленное
    await flush();
    inner.release();     //завершилась доставка последнего накопленного
    //Промис первого вызова разрешается, когда цикл опустеет полностью.
    await drained;

    assert.deepEqual(inner.delivered, [10, 13], "11 и 12 выброшены как устаревшие");
});

test("события без наложения доставляются все", async () => {
    const inner = createControllable();
    const notifier = new LatestOnlyNotifier(inner, createLogger().logger);

    for (const players of [1, 2, 3]) {
        const delivery = notifier.notify(viewEvent(players));
        await flush();
        inner.release();
        await delivery;
    }

    assert.deepEqual(inner.delivered, [1, 2, 3]);
});

test("отказ доставки пробрасывается наружу, чтобы диспетчер его залогировал", async () => {
    const inner = createControllable();
    const notifier = new LatestOnlyNotifier(inner, createLogger().logger);

    inner.failNext(new Error("Channel not found"));
    //Обработчик отказа навешиваем ДО release, иначе поймаем unhandled rejection.
    const assertion = assert.rejects(notifier.notify(viewEvent(10)), /Channel not found/);
    await flush();
    inner.release();

    await assertion;
});

test("состояние, пришедшее во время упавшей доставки, теряется — и это видно в логе", async () => {
    //Доставка упала, цикла больше нет, а накопленное состояние забрать некому: ServerMonitor
    //эмитит viewChanged только при ИЗМЕНЕНИИ, поэтому следующего события может не быть вовсе.
    //Тест фиксирует поведение обёртки как есть и проверяет, что потеря не молчаливая.
    //Что потерянное состояние доезжает следующим тиком StateSync — проверяется в StateSync.test.ts
    //(«состояние, потерянное упавшей доставкой, доезжает следующим тиком»).
    const inner = createControllable();
    const {logger, warnings} = createLogger();
    const notifier = new LatestOnlyNotifier(inner, logger);

    inner.failNext(new Error("TeamSpeak недоступен"));
    const failed = assert.rejects(notifier.notify(viewEvent(10)));
    await flush();

    //Пока падающая доставка висит, приходит новое состояние.
    void notifier.notify(viewEvent(99));
    await flush();

    inner.release();
    await failed;
    await flush();

    assert.deepEqual(inner.delivered, [], "99 не доставлено: цикла больше нет");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.message, "Pending notification dropped after delivery failure");
});

test("после отказа обёртка не залипает: следующее событие доставляется", async () => {
    const inner = createControllable();
    const notifier = new LatestOnlyNotifier(inner, createLogger().logger);

    inner.failNext(new Error("Channel not found"));
    const failed = assert.rejects(notifier.notify(viewEvent(10)));
    await flush();
    inner.release();
    await failed;

    const delivery = notifier.notify(viewEvent(20));
    await flush();
    inner.release();
    await delivery;

    assert.deepEqual(inner.delivered, [20], "после упавшей доставки обёртка снова работает");
});
