import test from "node:test";
import assert from "node:assert/strict";
import {planPoll, type PollPolicyOptions, type PollState} from "./PollPolicy.js";

//Прод-значения: так читать тесты проще, чем абстрактные числа.
const options: PollPolicyOptions = {
    pollIntervalMs: 5_000,
    suspiciousPollIntervalMs: 1_000,
    maxFailedChecks: 5,
    watchPollIntervalMs: 1_000,
    watchTimeoutMs: 1_000,
    watchMaxFailedChecks: 2,
};

function state(overrides: Partial<PollState> = {}): PollState {
    return {status: "online", failedChecks: 0, watched: false, ...overrides};
}

test("здоровый сервер опрашивается обычно: интервал, порог и таймаут из конфига", () => {
    assert.deepEqual(planPoll(state(), options), {delayMs: 5_000, maxFailedChecks: 5, timeoutCapMs: undefined});
});

test("после неудачи учащаемся, а порог и таймаут прежние — как было до политики", () => {
    assert.deepEqual(
        planPoll(state({failedChecks: 1}), options),
        {delayMs: 1_000, maxFailedChecks: 5, timeoutCapMs: undefined},
    );
});

test("у лежащего сервера подозрения нет: он уже offline, учащать нечего", () => {
    assert.equal(planPoll(state({status: "offline", failedChecks: 5}), options).delayMs, 5_000);
});

test("неизвестный статус с неудачей — тоже подозрение, как и раньше", () => {
    assert.equal(planPoll(state({status: "unknown", failedChecks: 1}), options).delayMs, 1_000);
});

test("ожидается простой: часто, с коротким таймаутом и подтверждением в две неудачи", () => {
    assert.deepEqual(
        planPoll(state({watched: true}), options),
        {delayMs: 1_000, maxFailedChecks: 2, timeoutCapMs: 1_000},
    );
});

test("режим ожидания действует и у лежащего сервера — чтобы быстрее заметить подъём", () => {
    assert.deepEqual(
        planPoll(state({status: "offline", failedChecks: 2, watched: true}), options),
        {delayMs: 1_000, maxFailedChecks: 2, timeoutCapMs: 1_000},
    );
});

test("режимы складываются: из каждого берётся самое строгое", () => {
    //Подозрение даёт интервал 300, ожидание — порог и таймаут. Ни один не отменяет другого.
    const plan = planPoll(
        state({failedChecks: 1, watched: true}),
        {...options, suspiciousPollIntervalMs: 300},
    );

    assert.deepEqual(plan, {delayMs: 300, maxFailedChecks: 2, timeoutCapMs: 1_000});
});

test("режим не может ослабить опрос: «учащение» реже обычного не замедляет", () => {
    const plan = planPoll(
        state({failedChecks: 1, watched: true}),
        {...options, suspiciousPollIntervalMs: 60_000, watchPollIntervalMs: 30_000, watchMaxFailedChecks: 10},
    );

    assert.equal(plan.delayMs, 5_000);
    assert.equal(plan.maxFailedChecks, 5);
});
