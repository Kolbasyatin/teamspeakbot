import test from "node:test";
import assert from "node:assert/strict";
import {renderStartupNotice, type StartupReport} from "./StartupNoticeMessage.js";

const NOW = new Date("2026-11-24T12:00:00Z");

function report(overrides: Partial<StartupReport> = {}): StartupReport {
    return {
        version: "7d8e50612345678901234567890123456789abcd",
        now: NOW,
        lastConfirmedAt: new Date(NOW.getTime() - 45_000),
        savedStates: 2,
        restoredStates: 2,
        restoreMaxAgeMs: 600_000,
        deliveries: 4,
        ...overrides,
    };
}

test("обычное обновление: короткий SHA, простой в секундах, статусы восстановлены", () => {
    const text = renderStartupNotice(report());

    assert.match(text, /версия <code>7d8e506<\/code>/);
    assert.match(text, /Не работал ≈ 45 с \(последнее подтверждение — 24\.11, 14:59:15 МСК\)/);
    assert.match(text, /Статусы восстановлены: 2 из 2/);
    assert.match(text, /Память уведомлений: 4/);
});

test("долгий простой: сохранённое устарело, статусы начнутся с unknown", () => {
    const text = renderStartupNotice(report({lastConfirmedAt: new Date(NOW.getTime() - 3 * 3_600_000), restoredStates: 0}));

    assert.match(text, /Не работал ≈ 3 ч 0 мин/);
    assert.match(text, /не восстановлены: сохранённые старше 10 мин/);
});

test("первый запуск с памятью и версия вне CI", () => {
    const text = renderStartupNotice(report({version: "dev", lastConfirmedAt: undefined, savedStates: 0, restoredStates: 0}));

    assert.match(text, /версия <code>dev<\/code>/);
    assert.match(text, /Сохранённых статусов нет/);
});
