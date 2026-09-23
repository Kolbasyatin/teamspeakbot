import type {Context, MiddlewareFn, Transformer} from "grammy";
import type {Update} from "grammy/types";
import type {Logger} from "pino";

//Диагностика работы с Telegram: видно, ходит ли бот за апдейтами, что обрабатывает и где встал.
//
//Зачем. Встроенный long polling grammy обрабатывает апдейты СТРОГО ПО ОЧЕРЕДИ: следующий getUpdates
//уходит только после того, как отработали обработчики предыдущей пачки. Один повисший обработчик
//останавливает приём команд навсегда — без ошибки и без строчки в логе, а уведомления при этом
//продолжают уходить (sendMessage циклу не подчинён). Сам grammy о повторах getUpdates пишет только
//в debug-канал своей библиотеки, то есть в проде молчит и о сетевых отказах.
//
//Поэтому смотрим с двух сторон:
//  исходящие вызовы Bot API — трансформер (createApiLogger): getUpdates видно целиком;
//  входящие апдейты — middleware (createUpdateLogger): что пришло и сколько обрабатывалось.
//Оба кормят PollingWatchdog, который и отвечает на главный вопрос: «polling жив или встал, и на чём».
//Здесь же createUpdateDeadline — страховка от того же дефекта, в конце файла.

//Long-poll timeout у grammy — 30 с: getUpdates, который дольше не вернулся, уже подозрителен.
//90 с — три таких периода: запас на медленную сеть, но достаточно рано, чтобы увидеть в логе.
const STALL_MS = 90_000;
//Сводка «polling жив» на info: в проде уровень info, а знать, что бот ходит за командами, нужно
//без включения debug. Раз в 10 минут — 144 строки в сутки, это не шум.
const HEARTBEAT_MS = 10 * 60_000;
//Порог «медленно» для обработчика и для вызова API. Ответ на команду дольше 10 с человек
//воспринимает как «бот не отвечает».
const SLOW_MS = 10_000;

//Апдейт в одну строку для лога. Текст сообщений не пишем: в лог уходит только команда
//и данные кнопки — этого достаточно, чтобы понять, на чём встал бот, и не хранить переписку.
export interface UpdateSummary {
    updateId: number;
    kind: string;
    chatId?: number;
    command?: string;
    callbackData?: string;
}

export function describeUpdate(update: Update): UpdateSummary {
    const kind = Object.keys(update).find(key => key !== "update_id") ?? "unknown";
    const summary: UpdateSummary = {updateId: update.update_id, kind};

    const message = update.message ?? update.edited_message ?? update.channel_post;
    if (message) {
        summary.chatId = message.chat.id;
        const text = message.text;
        if (text?.startsWith("/")) {
            summary.command = text.split(/\s/, 1)[0] ?? text;
        }
    }

    const callback = update.callback_query;
    if (callback) {
        if (callback.message) {
            summary.chatId = callback.message.chat.id;
        }
        if (callback.data !== undefined) {
            summary.callbackData = callback.data;
        }
    }

    const member = update.my_chat_member ?? update.chat_member;
    if (member) {
        summary.chatId = member.chat.id;
    }

    return summary;
}

interface InFlightUpdate {
    summary: UpdateSummary;
    startedAt: number;
}

//Состояние цикла polling и решение «жив или встал». Часов и таймеров внутри нет: время приходит
//параметром, а check() дёргает владелец по своему интервалу — поэтому логика проверяется без сети
//и без ожидания.
export class PollingWatchdog {
    //Последний признак жизни цикла: getUpdates начался или закончился (успехом или ошибкой).
    private lastProgressAt: number | undefined;
    private pollStartedAt: number | undefined;
    private readonly inFlight = new Map<number, InFlightUpdate>();

    //Эпизод остановки сообщаем один раз при обнаружении и один раз при восстановлении,
    //а не каждой проверкой: иначе час простоя дал бы 240 одинаковых строк.
    private stalledSince: number | undefined;
    //Ошибки getUpdates подряд. При отказе сети grammy повторяет каждые 3 с — warn только на первую.
    private consecutivePollErrors = 0;

    private lastHeartbeatAt: number | undefined;
    private polls = 0;
    private updates = 0;
    private pollErrors = 0;

    constructor(
        private readonly logger: Logger,
        private readonly stallMs: number = STALL_MS,
        private readonly heartbeatMs: number = HEARTBEAT_MS,
    ) {
    }

    //Точка отсчёта: до старта polling проверять нечего, а после — молчание уже считается.
    public started(now: number): void {
        this.lastProgressAt = now;
        this.lastHeartbeatAt = now;
    }

    public pollStarted(now: number): void {
        this.pollStartedAt = now;
        this.progress(now);
    }

    public pollSucceeded(now: number, updateCount: number): void {
        const durationMs = this.pollDuration(now);
        this.polls++;
        this.updates += updateCount;

        if (this.consecutivePollErrors > 0) {
            this.logger.info(
                {failedAttempts: this.consecutivePollErrors},
                "getUpdates снова проходит",
            );
            this.consecutivePollErrors = 0;
        }

        this.logger.debug({updateCount, durationMs}, "getUpdates");
        this.progress(now);
    }

    public pollFailed(now: number, error: unknown): void {
        const durationMs = this.pollDuration(now);
        this.pollErrors++;
        this.consecutivePollErrors++;

        //Первая ошибка — warn, последующие подряд — debug: grammy повторяет сам, а причина
        //у серии обычно одна. Итог серии виден по «getUpdates снова проходит».
        const level = this.consecutivePollErrors === 1 ? "warn" : "debug";
        this.logger[level](
            {error, durationMs, attempt: this.consecutivePollErrors},
            "getUpdates не прошёл, grammy повторит",
        );
        this.progress(now);
    }

    public updateStarted(now: number, summary: UpdateSummary): void {
        this.inFlight.set(summary.updateId, {summary, startedAt: now});
    }

    public updateFinished(updateId: number): void {
        this.inFlight.delete(updateId);
    }

    //Вызывается периодически. Ничего не возвращает наружу, кроме лога: это наблюдение, а не управление.
    public check(now: number): void {
        if (this.lastProgressAt === undefined) {
            return;
        }

        const silentMs = now - this.lastProgressAt;

        if (silentMs >= this.stallMs && this.stalledSince === undefined) {
            this.stalledSince = this.lastProgressAt;
            this.logger.error(this.stallDetails(now, silentMs), "Polling Telegram стоит — бот не принимает команды");
        }

        this.heartbeat(now);
    }

    private progress(now: number): void {
        this.lastProgressAt = now;

        if (this.stalledSince !== undefined) {
            this.logger.warn({stalledMs: now - this.stalledSince}, "Polling Telegram ожил");
            this.stalledSince = undefined;
        }
    }

    private pollDuration(now: number): number | undefined {
        const durationMs = this.pollStartedAt === undefined ? undefined : now - this.pollStartedAt;
        this.pollStartedAt = undefined;
        return durationMs;
    }

    //Главное в этой строке — ПОЧЕМУ стоит. Три случая различимы по состоянию:
    //  висит обработка апдейта — цикл ждёт обработчик, getUpdates не зовётся (отсюда и берётся зависание);
    //  висит сам getUpdates — сеть: соединение молча умерло, grammy ждёт свой таймаут (500 с);
    //  ни того, ни другого — цикл остановлен или не запущен.
    private stallDetails(now: number, silentMs: number): Record<string, unknown> {
        const hangingUpdates = [...this.inFlight.values()].map(item => ({
            ...item.summary,
            handlingMs: now - item.startedAt,
        }));

        if (hangingUpdates.length > 0) {
            return {silentMs, reason: "обработчик апдейта не завершается", hangingUpdates};
        }

        if (this.pollStartedAt !== undefined) {
            return {silentMs, reason: "getUpdates не возвращается", pollingForMs: now - this.pollStartedAt};
        }

        return {silentMs, reason: "getUpdates не вызывается"};
    }

    private heartbeat(now: number): void {
        if (this.lastHeartbeatAt === undefined || now - this.lastHeartbeatAt < this.heartbeatMs) {
            return;
        }

        this.logger.info(
            {
                periodMs: now - this.lastHeartbeatAt,
                polls: this.polls,
                updates: this.updates,
                pollErrors: this.pollErrors,
                stalled: this.stalledSince !== undefined,
            },
            "Telegram polling: сводка за период",
        );

        this.lastHeartbeatAt = now;
        this.polls = 0;
        this.updates = 0;
        this.pollErrors = 0;
    }
}

//Трансформер Bot API: единая точка, через которую проходит любой вызов — и getUpdates цикла,
//и ответы команд, и уведомления. Ставится в одном месте, поэтому новый вызов не может остаться
//без лога.
//
//Ошибка Bot API приходит сюда ответом {ok: false}, а не исключением — исключение бывает только
//у сети и отмены. Обрабатываются оба пути; результат и исключение пробрасываются как есть.
export function createApiLogger(
    logger: Logger,
    watchdog: PollingWatchdog,
    now: () => number = () => Date.now(),
): Transformer {
    return async (prev, method, payload, signal) => {
        const startedAt = now();
        const isPoll = method === "getUpdates";

        if (isPoll) {
            watchdog.pollStarted(startedAt);
        }

        try {
            const response = await prev(method, payload, signal);
            const finishedAt = now();

            if (isPoll) {
                if (response.ok) {
                    watchdog.pollSucceeded(finishedAt, Array.isArray(response.result) ? response.result.length : 0);
                } else {
                    watchdog.pollFailed(finishedAt, {code: response.error_code, description: response.description});
                }
                return response;
            }

            const durationMs = finishedAt - startedAt;
            const chatId = chatIdOf(payload);

            if (!response.ok) {
                logger.warn(
                    {method, chatId, durationMs, code: response.error_code, description: response.description},
                    "Bot API вернул ошибку",
                );
            } else if (durationMs >= SLOW_MS) {
                logger.warn({method, chatId, durationMs}, "Медленный вызов Bot API");
            } else {
                logger.debug({method, chatId, durationMs}, "Bot API");
            }

            return response;
        } catch (error) {
            const finishedAt = now();

            if (isPoll) {
                watchdog.pollFailed(finishedAt, error);
            } else {
                logger.warn(
                    {method, chatId: chatIdOf(payload), durationMs: finishedAt - startedAt, error},
                    "Вызов Bot API не прошёл",
                );
            }

            throw error;
        }
    };
}

function chatIdOf(payload: unknown): unknown {
    return typeof payload === "object" && payload !== null && "chat_id" in payload
        ? payload.chat_id
        : undefined;
}

//Middleware на каждый входящий апдейт. Стоит ПЕРВЫМ, до наборов команд, чтобы замер включал
//всю обработку. Ошибку не гасит: её ловит и пишет bot.catch, здесь только длительность.
export function createUpdateLogger(
    logger: Logger,
    watchdog: PollingWatchdog,
    now: () => number = () => Date.now(),
): MiddlewareFn<Context> {
    return async (ctx, next) => {
        const summary = describeUpdate(ctx.update);
        const startedAt = now();

        watchdog.updateStarted(startedAt, summary);
        logger.debug(summary, "Апдейт Telegram получен");

        let failed = false;
        try {
            await next();
        } catch (error) {
            failed = true;
            throw error;
        } finally {
            watchdog.updateFinished(summary.updateId);

            const durationMs = now() - startedAt;
            if (durationMs >= SLOW_MS) {
                logger.warn({...summary, durationMs, failed}, "Апдейт Telegram обрабатывался долго");
            } else {
                logger.debug({...summary, durationMs, failed}, "Апдейт Telegram обработан");
            }
        }
    };
}

//Дедлайн на обработку одного апдейта. Не диагностика, а страховка — но живёт рядом с ней, потому
//что защищает тот же цикл от того же дефекта.
//
//Обработчик, не уложившийся в срок, НЕ отменяется — в JS отменить чужой промис нельзя. Он дорабатывает
//(или висит) в фоне, а цикл идёт за следующими апдейтами. Цена: запоздалый ответ может прийти после
//следующих, и у одного апдейта могут одновременно работать два обработчика. Это лучше, чем бот,
//глухой до перезапуска контейнера.
//
//Ставится ПОСЛЕ createUpdateLogger: тогда логгер снимает отметку «в работе» по дедлайну, и watchdog
//не будет называть виновником апдейт, который цикл давно отпустил.
export function createUpdateDeadline(logger: Logger, timeoutMs: number): MiddlewareFn<Context> {
    return async (ctx, next) => {
        const work = next();
        let timer: NodeJS.Timeout | undefined;
        let timedOut = false;

        const deadline = new Promise<void>(resolve => {
            timer = setTimeout(() => {
                timedOut = true;
                resolve();
            }, timeoutMs);
        });

        //Ошибку после дедлайна bot.catch уже не увидит — цикл ушёл дальше, поэтому пишем её здесь.
        //До дедлайна она пробрасывается через race как обычно.
        work.catch((error: unknown) => {
            if (timedOut) {
                logger.error({...describeUpdate(ctx.update), error}, "Обработчик апдейта упал уже после дедлайна");
            }
        });

        try {
            await Promise.race([work, deadline]);
        } finally {
            clearTimeout(timer);
        }

        if (timedOut) {
            logger.error(
                {...describeUpdate(ctx.update), timeoutMs},
                "Обработчик апдейта не уложился в срок — бот идёт за следующими апдейтами, обработчик брошен",
            );
        }
    };
}
