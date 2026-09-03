//HTTP-запрос за JSON с таймаутом. Общий кусок RestQuerier и BohemiaLobbyQuerier: оба ходят
//fetch'ем, обоим нужен AbortController на timeout из конфига источника, оба разбирают JSON.
//Что делать с кодом ответа, решает вызывающий: для REST любой не-2xx — неудача, для Bohemia
//401/403 — отдельный случай «токен протух». Поэтому статус отдаётся, а не превращается в ошибку.
//Тело читается только при ok: у ошибки оно может быть не JSON, и падать на нём незачем.

export interface JsonResponse {
    ok: boolean;
    status: number;
    body: unknown;
}

export interface JsonRequest {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
}

export async function fetchJson(url: string, request: JsonRequest): Promise<JsonResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
        const response = await fetch(url, {
            method: request.method ?? "GET",
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                ...request.headers,
            },
            ...(request.body === undefined ? {} : {body: request.body}),
        });

        return {
            ok: response.ok,
            status: response.status,
            body: response.ok ? await response.json() : undefined,
        };
    } finally {
        clearTimeout(timeoutId);
    }
}
