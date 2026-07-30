export interface RetryOptions {
    //Общее число попыток, включая первую.
    attempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    onRetry?: (error: unknown, attempt: number, nextDelayMs: number) => void;
}

//Повтор с экспоненциальным backoff. Последняя неудача пробрасывается наружу как есть.
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
    let delayMs = options.initialDelayMs;

    for (let attempt = 1; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= options.attempts) {
                throw error;
            }

            options.onRetry?.(error, attempt, delayMs);
            await sleep(delayMs);
            delayMs = Math.min(delayMs * 2, options.maxDelayMs);
        }
    }
}

function sleep(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}
