import type {
    Querier,
    QueryFieldMap,
    RestQueryConfig,
    ServerQueryConfig,
    ServerQueryField,
    ServerQueryResult,
} from "../monitoring/ServerQuery.js";
import type {Logger} from "pino";

export class RestQuerier implements Querier {
    constructor(private readonly logger: Logger) {
    }

    public async query(config: ServerQueryConfig): Promise<ServerQueryResult | undefined> {
        const restConfig = config as RestQueryConfig;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), restConfig.timeout);

        try {
            const response = await fetch(restConfig.url, {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return this.toQueryResult(await response.json(), restConfig);
        } catch (error) {
            this.logger.debug(`REST query failed for ${restConfig.url}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    //response.json() возвращает any, поэтому форму ответа приходится проверять руками.
    //Что где лежит, знает не этот класс, а карта из конфига источника: у каждого эндпоинта свои
    //имена полей, и зашивать сюда players/maxPlayers значило бы обслуживать только те API,
    //которые писали под этот домен.
    //
    //Разбор идёт ПОЛЕ ЗА ПОЛЕМ, а не «все или ничего». Раньше ответ без players целиком
    //приравнивался к неудачному опросу, и для единственного источника это было верно. С несколькими
    //источниками правило стало вредным — второстепенный REST, приносящий одну лишь длину очереди,
    //выбрасывал бы собственные валидные данные. Чего не хватает, доберёт слияние.
    private toQueryResult(payload: unknown, config: RestQueryConfig): ServerQueryResult | undefined {
        if (!payload || typeof payload !== "object") {
            this.logger.debug(`REST query for ${config.url} returned a non-object payload`);
            return undefined;
        }

        const result = this.extractFields(payload as Record<string, unknown>, config.fields);

        //Объект, из которого не вытащить ни одного поля, неотличим от поломанного эндпоинта:
        //так выглядит и {"error":"server not found"} с кодом 200. Это по-прежнему неудачный опрос,
        //иначе такой сервер считался бы живым.
        if (Object.keys(result).length === 0) {
            this.logger.debug(`REST query for ${config.url} returned no usable fields`);
            return undefined;
        }

        return result;
    }

    private extractFields(body: Record<string, unknown>, fields: QueryFieldMap): ServerQueryResult {
        const result: Record<string, unknown> = {};

        for (const [field, path] of Object.entries(fields) as [ServerQueryField, string][]) {
            const value = readPath(body, path);

            //Number.isFinite отсеивает строки, null, NaN и Infinity. Непригодное поле пропускается,
            //а не портит весь ответ, и не приводится к числу молча: "42" строкой — это сломанный
            //эндпоинт, и прятать его не нужно.
            if (Number.isFinite(value)) {
                result[field] = value;
            }
        }

        return result as ServerQueryResult;
    }
}

//Путь с точкой как разделителем: "data.online". Без вложенности карта не выполняла бы своей задачи —
//первый же реальный API потребовал бы правки кода, ради избавления от которой она и заводилась.
//Любой обрыв пути (нет ключа, наткнулись на не-объект, наткнулись на null) даёт undefined:
//для вызывающего это то же самое, что непригодное значение.
function readPath(body: Record<string, unknown>, path: string): unknown {
    return path.split(".").reduce<unknown>(
        (current, key) => (current && typeof current === "object"
            ? (current as Record<string, unknown>)[key]
            : undefined),
        body,
    );
}
