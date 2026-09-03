import {fetchJson} from "./fetchJson.js";
import type {Logger} from "pino";

//Откуда querier Bohemia берёт access token. Интерфейс отдельно от реализации ради тестов
//querier'а: там токен подменяется константой, HTTP к соседнему сервису не при чём.
export interface BiTokenSource {
    getToken(): Promise<string | undefined>;
    //Токен отвергнут бэкендом (401/403): забыть кэш, следующий getToken сходит за новым.
    invalidate(): void;
}

export interface BiTokenProviderOptions {
    //Пустой URL — источник токенов не настроен: getToken всегда отдаёт undefined, и все
    //bohemia-источники молчат. Это не ошибка конфигурации, а выключатель: очередь — необязательная
    //добавка, и стенд без соседнего сервиса должен работать.
    url: string;
    timeoutMs: number;
    //За сколько до expiresAt считать токен протухшим и идти за новым. Соседний сервис сам
    //обновляет его за несколько минут до истечения, поэтому запас нужен небольшой.
    refreshLeadMs: number;
}

//Клиент к соседнему сервису arma-reforger-hz: GET /token → {accessToken, expiresAt}.
//Тот сервис ходит в Steam и Bohemia и держит токен свежим; здесь только кэш до expiresAt
//и один запрос на все серверы сразу (параллельные getToken делят один in-flight fetch:
//при десяти серверах на тике соседа спросят один раз, а не десять).
//
//Отказ соседа — не событие уровня сервера: bohemia-источники в этот тик молчат, статус
//не трогается. Поэтому наружу исключений нет — undefined, а в лог warn один раз на эпизод
//недоступности и info при восстановлении, а не строка на каждый тик каждого сервера.
export class BiTokenProvider implements BiTokenSource {
    private cached: {accessToken: string; expiresAt: number} | undefined;
    private inFlight: Promise<string | undefined> | undefined;
    private unavailable = false;

    constructor(
        private readonly options: BiTokenProviderOptions,
        private readonly logger: Logger,
        private readonly now: () => number = Date.now,
    ) {
        if (!options.url) {
            logger.info("BOHEMIA_TOKEN_URL пуст — источники bohemia отключены, очередь не собирается");
        }
    }

    public async getToken(): Promise<string | undefined> {
        if (!this.options.url) {
            return undefined;
        }

        if (this.cached && this.now() < this.cached.expiresAt - this.options.refreshLeadMs) {
            return this.cached.accessToken;
        }

        this.inFlight ??= this.fetchToken().finally(() => {
            this.inFlight = undefined;
        });

        return this.inFlight;
    }

    public invalidate(): void {
        this.cached = undefined;
    }

    private async fetchToken(): Promise<string | undefined> {
        try {
            const response = await fetchJson(this.options.url, {timeoutMs: this.options.timeoutMs});

            //404 — штатный ответ соседа «токена пока нет»: он только стартовал, или Steam/BI
            //недоступны. Для нас это то же, что недоступность, только с понятной причиной.
            if (response.status === 404) {
                throw new Error("token service has no token yet (404)");
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const token = parseToken(response.body);

            this.cached = token;
            this.recovered();

            return token.accessToken;
        } catch (error) {
            this.failed(error);

            return undefined;
        }
    }

    private failed(error: unknown): void {
        if (!this.unavailable) {
            this.logger.warn(
                {error, url: this.options.url},
                "Сервис токенов Bohemia недоступен — источники bohemia молчат, пока он не вернётся",
            );
        }

        this.unavailable = true;
    }

    private recovered(): void {
        if (this.unavailable) {
            this.logger.info("Сервис токенов Bohemia снова отвечает");
        }

        this.unavailable = false;
    }
}

//Форма ответа GET /token — контракт соседнего сервиса (TokenResponse в arma-reforger-hz):
//accessToken строкой, expiresAt в ISO 8601. Всё остальное — сломанный ответ, а не «почти токен».
function parseToken(body: unknown): {accessToken: string; expiresAt: number} {
    const payload = body as {accessToken?: unknown; expiresAt?: unknown} | null;
    const accessToken = payload?.accessToken;
    const expiresAt = typeof payload?.expiresAt === "string" ? Date.parse(payload.expiresAt) : NaN;

    if (typeof accessToken !== "string" || accessToken === "" || !Number.isFinite(expiresAt)) {
        throw new Error("token service returned an unexpected payload");
    }

    return {accessToken, expiresAt};
}
