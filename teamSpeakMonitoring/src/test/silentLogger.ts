import type {Logger} from "pino";

//Логгер-заглушка для тестов: проверяется поведение, а вывод в консоль только мешает читать отчёт.
export const silentLogger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    fatal: (): void => undefined,
    trace: (): void => undefined,
} as unknown as Logger;
