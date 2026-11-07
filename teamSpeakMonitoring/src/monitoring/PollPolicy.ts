import type {ServerStatus} from "./ServerProbe.js";

//Политика опроса: как часто спрашивать сервер, сколько ждать ответа и сколько неудач подряд
//считать падением. Чистая функция — состояние на входе, план на выходе; ни часов, ни таймеров.
//
//Зачем отдельно. Раньше правило было одно и жило в мониторе строчкой «была неудача — чаще».
//После игры 1.9 понадобилось второе основание (ждём перезапуска — опрашиваем часто и без долгого
//подтверждения, telegram.md §11), и оснований станет больше. Каждое — режим, и режимы
//СКЛАДЫВАЮТСЯ, а не заменяют друг друга: из всех действующих берётся самое строгое значение
//каждого параметра. Поэтому новый режим ничего не ломает в старых и не знает про них.
//
//Отсюда и следствие: режим может только ужесточить опрос, но не ослабить. Учащение
//с интервалом больше обычного не замедлит опрос — возьмётся обычный.

//Что политике нужно знать о сервере перед опросом.
export interface PollState {
    status: ServerStatus;
    failedChecks: number;
    //Включено ли пристальное наблюдение: снаружи сказали, что скоро ожидается простой.
    watched: boolean;
}

export interface PollPlan {
    //Через сколько запускать следующий опрос.
    delayMs: number;
    //Сколько неудач подряд делают сервер offline.
    maxFailedChecks: number;
    //Потолок таймаута главного источника. undefined — таймаут из query_config как есть.
    //Нужен потому, что цикл неудачи определяет таймаут, а не интервал: опрос «раз в секунду»
    //с таймаутом A2S в 5 секунд на деле идёт раз в шесть.
    timeoutCapMs: number | undefined;
}

export interface PollPolicyOptions {
    pollIntervalMs: number;
    suspiciousPollIntervalMs: number;
    maxFailedChecks: number;
    watchPollIntervalMs: number;
    watchTimeoutMs: number;
    watchMaxFailedChecks: number;
}

//Вклад одного режима: только те параметры, которые он ужесточает.
type PollAdjustment = Partial<PollPlan>;

export function planPoll(state: PollState, options: PollPolicyOptions): PollPlan {
    const base: PollPlan = {
        delayMs: options.pollIntervalMs,
        maxFailedChecks: options.maxFailedChecks,
        timeoutCapMs: undefined,
    };

    return modes(state, options).reduce(stricter, base);
}

//Действующие режимы. Новый режим — ещё одна ветка здесь, остальные не трогаются.
function modes(state: PollState, options: PollPolicyOptions): PollAdjustment[] {
    const adjustments: PollAdjustment[] = [];

    //Подозрение: неудача была, но порог offline ещё не набран. Учащаем, чтобы быстрее понять,
    //упал ли сервер на самом деле. У лежащего сервера учащать нечего — он и так offline.
    if (state.status !== "offline" && state.failedChecks > 0) {
        adjustments.push({delayMs: options.suspiciousPollIntervalMs});
    }

    //Ожидается простой: опрашиваем часто, ждём недолго и подтверждаем падение быстрее.
    //Действует и у лежащего сервера — тогда быстрее заметим, что он поднялся.
    if (state.watched) {
        adjustments.push({
            delayMs: options.watchPollIntervalMs,
            timeoutCapMs: options.watchTimeoutMs,
            maxFailedChecks: options.watchMaxFailedChecks,
        });
    }

    return adjustments;
}

function stricter(plan: PollPlan, adjustment: PollAdjustment): PollPlan {
    return {
        delayMs: Math.min(plan.delayMs, adjustment.delayMs ?? plan.delayMs),
        maxFailedChecks: Math.min(plan.maxFailedChecks, adjustment.maxFailedChecks ?? plan.maxFailedChecks),
        timeoutCapMs: plan.timeoutCapMs === undefined
            ? adjustment.timeoutCapMs
            : Math.min(plan.timeoutCapMs, adjustment.timeoutCapMs ?? plan.timeoutCapMs),
    };
}
