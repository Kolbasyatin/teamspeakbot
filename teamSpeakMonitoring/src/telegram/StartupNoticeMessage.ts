import {escapeHtml} from "./escapeHtml.js";

//Сообщение root о запуске бота (итерация 22). Чистая функция: время — параметром.

export interface StartupReport {
    version: string;
    now: Date;
    //Последнее подтверждение статусов прошлым процессом: оценка того, когда бот перестал работать.
    lastConfirmedAt: Date | undefined;
    //Сколько статусов серверов сохранено и сколько из них восстановлено (свежие).
    savedStates: number;
    restoredStates: number;
    restoreMaxAgeMs: number;
    //Сколько записей «что какому чату доставлено» прочитано.
    deliveries: number;
}

const TIME = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Europe/Moscow",
});

export function renderStartupNotice(report: StartupReport): string {
    const lines = [`🔄 Бот запущен · версия <code>${escapeHtml(shortVersion(report.version))}</code>`];

    if (report.lastConfirmedAt === undefined) {
        lines.push("Сохранённых статусов нет — первый запуск с памятью: статусы начнутся с unknown.");
    } else {
        const downtimeMs = report.now.getTime() - report.lastConfirmedAt.getTime();
        lines.push(`Не работал ≈ ${formatDuration(downtimeMs)} (последнее подтверждение — ${TIME.format(report.lastConfirmedAt)} МСК).`);

        if (report.restoredStates > 0) {
            lines.push(`Статусы восстановлены: ${report.restoredStates} из ${report.savedStates}.`);
        } else {
            lines.push(`Статусы не восстановлены: сохранённые старше ${formatDuration(report.restoreMaxAgeMs)}, начнутся с unknown.`);
        }
    }

    lines.push(`Память уведомлений: ${report.deliveries} — повторных «is online» не будет.`);

    return lines.join("\n");
}

//Полный SHA из CI — слишком длинно для глаз; первые семь символов однозначны для этого репозитория.
function shortVersion(version: string): string {
    return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
}

function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 90) {
        return `${seconds} с`;
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 90) {
        return `${minutes} мин`;
    }

    const hours = Math.floor(minutes / 60);

    return `${hours} ч ${minutes % 60} мин`;
}
