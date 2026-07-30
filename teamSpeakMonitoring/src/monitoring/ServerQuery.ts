//Контракт опроса: что подаётся querier'у на вход и что он обязан отдать на выход.
//Объявлен здесь, а не в ServerMonitor, чтобы queriers зависели от контракта, а не от потребителя.

export type ServerQueryConfig =
    | A2sQueryConfig
    | RestQueryConfig;

export interface A2sQueryConfig {
    type: "a2s";
    host: string;
    port: number;
    timeout: number;
}

export interface RestQueryConfig {
    type: "rest";
    url: string;
    timeout: number;
}

//Что querier отдаёт домену. Симметрично ServerQueryConfig: то на входе, это на выходе.
//Содержит ровно то, что домен читает, — никаких полей "на будущее" и ничего от библиотек:
//типы конкретных протоколов заперты внутри своих queriers и наружу не выходят.
//Добавление поля (например, размера очереди Arma Reforger) = строка здесь плюс маппинг
//в тех queriers, которые это поле реально умеют отдавать.
export interface ServerQueryResult {
    players: number;
    maxPlayers: number;
}

//Монитор не знает, по какому протоколу опрашивается сервер: он выбирает реализацию
//по ServerQueryConfig["type"] и получает доменный результат.
export interface Querier {
    query(config: ServerQueryConfig): Promise<ServerQueryResult | undefined>;
}

//Record, а не Map, намеренно: компилятор требует querier для КАЖДОГО варианта ServerQueryConfig.
//Добавили тип запроса в union — сборка падает, пока в composition root не появится его реализация.
//От мусора в БД это не спасает (там строки не типизированы), поэтому в мониторе остаётся
//проверка в рантайме.
export type QuerierRegistry = Record<ServerQueryConfig["type"], Querier>;
