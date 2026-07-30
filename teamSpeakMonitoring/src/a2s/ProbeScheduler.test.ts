import test from "node:test";
import assert from "node:assert/strict";
import type {Logger} from "pino";
import {Scheduler, type ScheduledTask, type ScheduledTaskId} from "./ProbeScheduler.js";

//Тесты на настоящих таймерах. Утверждения строятся на КОЛИЧЕСТВЕ запусков, а не на замерах
//времени: "если бы sync сбрасывал таймеры, задача не запустилась бы ни разу" — бинарный факт,
//поэтому тест не флакует.

//Задержка, заметно превышающая окна наблюдения: задача запускается один раз и больше не мешает.
const NEVER_AGAIN_MS = 10_000;

interface CountingTask extends ScheduledTask {
    runs: number;
}

function createTask(
    id: ScheduledTaskId,
    options: {delayMs: number; throwOnRun?: boolean; throwOnDelay?: boolean} = {delayMs: NEVER_AGAIN_MS},
): CountingTask {
    return {
        id,
        runs: 0,
        run: async function (this: CountingTask): Promise<void> {
            this.runs += 1;
            if (options.throwOnRun) {
                throw new Error(`task ${String(id)} failed`);
            }
        },
        getNextDelayMs: (): number => {
            if (options.throwOnDelay) {
                throw new Error(`task ${String(id)} cannot report delay`);
            }
            return options.delayMs;
        },
    };
}

function createLogger(): {logger: Logger; messages: string[]} {
    const messages: string[] = [];

    const logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (_context: unknown, message: string) => messages.push(message),
    } as unknown as Logger;

    return {logger, messages};
}

function wait(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

test("задачи не запускаются до start", async () => {
    const scheduler = new Scheduler<CountingTask>(createLogger().logger);
    const task = createTask(1, {delayMs: 5});

    scheduler.sync([task]);
    await wait(40);

    assert.equal(task.runs, 0);
    scheduler.stop();
});

test("start запускает все известные задачи немедленно", async () => {
    const scheduler = new Scheduler<CountingTask>(createLogger().logger);
    const first = createTask(1);
    const second = createTask(2);

    scheduler.sync([first, second]);
    scheduler.start();
    await wait(40);

    assert.equal(first.runs, 1);
    assert.equal(second.runs, 1);
    scheduler.stop();
});

test("задача перезапускается с задержкой из getNextDelayMs", async () => {
    const scheduler = new Scheduler<CountingTask>(createLogger().logger);
    const task = createTask(1, {delayMs: 25});

    scheduler.start();
    scheduler.sync([task]);
    await wait(130);
    scheduler.stop();

    //За 130 мс при задержке 25 мс ожидаем около пяти запусков. Границы широкие намеренно.
    assert.ok(task.runs >= 3, `ожидали >= 3 запусков, получили ${task.runs}`);
    assert.ok(task.runs <= 8, `ожидали <= 8 запусков, получили ${task.runs}`);
});

test("stop прекращает запуски", async () => {
    const scheduler = new Scheduler<CountingTask>(createLogger().logger);
    const task = createTask(1, {delayMs: 10});

    scheduler.sync([task]);
    scheduler.start();
    await wait(50);
    scheduler.stop();

    const runsAtStop = task.runs;
    assert.ok(runsAtStop > 0, "до stop задача должна была запускаться");

    await wait(60);
    assert.equal(task.runs, runsAtStop, "после stop новых запусков нет");
});

test("sync не перепланирует уже существующие задачи", async () => {
    //Главное свойство шедулера. sync ставит таймер только НОВЫМ задачам (schedule с задержкой 0),
    //существующие продолжают идти по своему таймеру. Иначе частые вызовы reload-servers
    //превращались бы в шторм опросов: каждый вызов дёргал бы все игровые серверы немедленно.
    const scheduler = new Scheduler<CountingTask>(createLogger().logger);
    //Задержка заведомо больше окна теста: после первого запуска задача сама не запустится.
    const task = createTask(1);

    scheduler.sync([task]);
    scheduler.start();
    await wait(20);
    assert.equal(task.runs, 1, "start запустил задачу один раз");

    for (let call = 0; call < 20; call += 1) {
        scheduler.sync([task]);
    }
    await wait(40);
    scheduler.stop();

    assert.equal(task.runs, 1, "20 вызовов sync не добавили ни одного лишнего запуска");
});

test("sync добавляет новую задачу и сразу её запускает, если шедулер работает", async () => {
    const scheduler = new Scheduler<CountingTask>(createLogger().logger);
    const first = createTask(1);

    scheduler.sync([first]);
    scheduler.start();
    await wait(20);

    const second = createTask(2);
    scheduler.sync([first, second]);
    await wait(20);
    scheduler.stop();

    assert.equal(second.runs, 1, "новая задача запускается без ожидания");
    assert.equal(first.runs, 1, "существующая задача не запускается повторно");
});

test("sync удаляет задачу, и она больше не запускается", async () => {
    const scheduler = new Scheduler<CountingTask>(createLogger().logger);
    const kept = createTask(1, {delayMs: 15});
    const removed = createTask(2, {delayMs: 15});

    scheduler.sync([kept, removed]);
    scheduler.start();
    await wait(50);

    const runsBeforeRemoval = removed.runs;
    assert.ok(runsBeforeRemoval > 0, "до удаления задача должна была запускаться");

    scheduler.sync([kept]);
    await wait(60);
    scheduler.stop();

    assert.equal(removed.runs, runsBeforeRemoval, "удалённая задача остановлена");
    assert.ok(kept.runs > runsBeforeRemoval, "оставшаяся задача продолжает работать");
});

test("исключение из run не выводит задачу из планирования", async () => {
    //Итерация 0: до правки первое же исключение навсегда лишало задачу таймера.
    const {logger, messages} = createLogger();
    const scheduler = new Scheduler<CountingTask>(logger);
    const failing = createTask(1, {delayMs: 15, throwOnRun: true});
    const healthy = createTask(2, {delayMs: 15});

    scheduler.sync([failing, healthy]);
    scheduler.start();
    await wait(120);
    scheduler.stop();

    assert.ok(failing.runs >= 3, `падающая задача должна перезапускаться, запусков: ${failing.runs}`);
    assert.ok(healthy.runs >= 3, `соседняя задача не должна страдать, запусков: ${healthy.runs}`);
    assert.ok(
        messages.every(message => message === "Scheduled task failed"),
        `неожиданные сообщения в логе: ${messages.join(", ")}`,
    );
    assert.equal(messages.length, failing.runs, "каждая неудача попадает в лог");
});

test("исключение из getNextDelayMs даёт fallback-задержку вместо потери задачи", async () => {
    //Итерация 0: без защиты нечем было бы планировать следующий запуск.
    const {logger, messages} = createLogger();
    const scheduler = new Scheduler<CountingTask>(logger);
    const task = createTask(1, {delayMs: 5, throwOnDelay: true});

    scheduler.sync([task]);
    scheduler.start();
    await wait(60);
    scheduler.stop();

    assert.equal(task.runs, 1, "задача запущена и перепланирована на fallback (5000 мс)");
    assert.deepEqual(messages, ["Scheduled task failed to report next delay"]);
});

test("сработавший таймер берёт актуальную версию задачи, а не захваченную при планировании", async () => {
    //Поэтому пересборка задач в ServerMonitor.getScheduledTasks() безопасна:
    //runTask достаёт задачу из мапы по id в момент срабатывания.
    const scheduler = new Scheduler<CountingTask>(createLogger().logger);
    const original = createTask(1, {delayMs: 40});

    scheduler.sync([original]);
    scheduler.start();
    await wait(15);
    assert.equal(original.runs, 1);

    const replacement = createTask(1, {delayMs: 40});
    scheduler.sync([replacement]);
    await wait(60);
    scheduler.stop();

    assert.equal(original.runs, 1, "старая версия задачи больше не вызывается");
    assert.ok(replacement.runs >= 1, "вызывается новая версия задачи с тем же id");
});
