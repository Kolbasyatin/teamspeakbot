//Контракт опроса: что подаётся querier'у на вход и что он обязан отдать на выход.
//Объявлен здесь, а не в ServerMonitor, чтобы queriers зависели от контракта, а не от потребителя.

export type ServerQueryConfig =
    | A2sQueryConfig
    | RestQueryConfig
    | BohemiaQueryConfig;

export interface A2sQueryConfig {
    type: "a2s";
    host: string;
    port: number;
    timeout: number;
}

//REST — это не протокол, а «любой HTTP, отдающий любой JSON». В отличие от A2S, форма ответа
//здесь на этапе компиляции неизвестна: у каждого эндпоинта свои имена полей и своя вложенность.
//Поэтому у него есть карта, а у A2S её нет и быть не может — там протокол фиксирован.
export interface RestQueryConfig {
    type: "rest";
    url: string;
    timeout: number;
    //Где в ответе искать каждое доменное поле. Ключ — доменное имя, значение — путь в JSON
    //с точкой как разделителем: {"players": "data.online"}.
    //Направление именно такое: карта отвечает на вопрос «где взять players», а не «куда девать
    //это непонятное поле». Лишние поля ответа отсеиваются сами — чего нет в карте, того нет.
    //Обязательна: значение по умолчанию «имена совпадают с доменными» — это предположение,
    //верное только для эндпоинта, написанного под этот домен, и неявное вдобавок.
    fields: QueryFieldMap;
}

export type QueryFieldMap = Partial<Record<ServerQueryField, string>>;

//Каталог серверов Bohemia (lobby/rooms/search) — фиксированный протокол, как A2S, поэтому карты
//полей у него нет: форма ответа известна на этапе компиляции и мапится кодом. В строке БД лежит
//только то, что отличает один сервер от другого — его игровой адрес. Всё протокольное (URL,
//User-Agent игры, clientVersion, токен) одинаково для всех серверов и живёт в env: вышел патч
//игры — правится одна переменная, а не строка каждого сервера.
//hostAddress — адрес ИГРОВОГО порта, тот же, что в game_address (37.48.253.41:2001), не A2S.
export interface BohemiaQueryConfig {
    type: "bohemia";
    hostAddress: string;
    timeout: number;
}

//Что querier отдаёт домену. Симметрично ServerQueryConfig: то на входе, это на выходе.
//Содержит ровно то, что домен читает, — никаких полей "на будущее" и ничего от библиотек:
//типы конкретных протоколов заперты внутри своих queriers и наружу не выходят.
//Добавление поля (например, размера очереди Arma Reforger) = строка здесь плюс маппинг
//в тех queriers, которые это поле реально умеют отдавать.
//
//Поля необязательные, потому что у сервера будет несколько источников, и каждый заполняет только
//то, что физически умеет отдать: A2S не знает длины очереди, сколько его ни настраивай. Набор полей
//задаётся типом источника, то есть кодом querier'а, и настройке не подлежит — настраивается только
//приоритет, то есть кто выигрывает при совпадении поля.
//Отсюда же следует, что результат одного источника и результат слияния нескольких — одна и та же
//форма: частично заполненная. Отдельного типа для слияния не нужно.
export interface ServerQueryResult {
    players?: number | undefined;
    maxPlayers?: number | undefined;
    //Очередь на вход. A2S её не знает в принципе, отдаёт только каталог Bohemia (или агрегатор,
    //который его зеркалит). Все три поля могут отсутствовать даже у ответившего источника:
    //joinQueue в ответе Bohemia необязателен целиком, а среднее ожидание — необязательно внутри него.
    queueSize?: number | undefined;
    queueMaxSize?: number | undefined;
    //Секунды, как отдаёт Bohemia (positionAvgWaitTime).
    queueAvgWaitTime?: number | undefined;
    //Как есть из источника. У Bohemia это либо человекочитаемое имя («Командующий - Колгуев»),
    //либо ключ локализации («#AR-Campaign_ScenarioName_Everon») — зависит от сервера. Что с этим
    //делать при показе, решает потребитель; здесь хранится то, что пришло.
    scenarioName?: string | undefined;
    //Код прямого подключения из каталога Bohemia. Строка, а не число: ведущие нули значимы.
    directJoinCode?: string | undefined;
    //Когда данные источника были актуальны, в миллисекундах эпохи. Для Bohemia это момент
    //последнего heartbeat сервера в каталог: очередь и сценарий не свежее этого времени.
    //players сюда не относится — при живом A2S они приезжают напрямую с сервера и побеждают
    //по приоритету, а это поле остаётся от того источника, который его принёс.
    dataUpdatedAt?: number | undefined;
}

export type ServerQueryField = keyof ServerQueryResult;

//Тип значения доменного поля. Нужен тому, кто читает поля из чужого JSON по карте (RestQuerier):
//имена он берёт из карты, а во что верить — отсюда. Раньше все поля были числами и проверка
//сводилась к Number.isFinite; с появлением строковых полей знать тип каждого стало необходимо.
export type ServerQueryFieldKind = "number" | "string";

//Единственное место, где доменные имена полей перечислены как ЗНАЧЕНИЕ, а не как тип.
//Нужно потому, что тип в рантайме не существует: карту полей, приехавшую из БД, сверять не с чем.
//Record, а не массив: добавили поле в ServerQueryResult — сборка падает, пока его не внесли сюда.
//Логикой этот список не управляет. Слияние в нём не нуждается вовсе (оно перебирает то, что
//источники уже принесли), A2S и Bohemia — тоже: они знают свой протокол. Его работа — проверять
//данные, пришедшие извне: имена в карте из БД и типы значений в чужом JSON.
export const SERVER_QUERY_FIELDS: Record<ServerQueryField, ServerQueryFieldKind> = {
    players: "number",
    maxPlayers: "number",
    queueSize: "number",
    queueMaxSize: "number",
    queueAvgWaitTime: "number",
    scenarioName: "string",
    directJoinCode: "string",
    dataUpdatedAt: "number",
};

//Имена в карте, которых нет среди доменных полей. Пустой массив — карта пригодна.
//Отдельно от того, кто бросает ошибку: словарь домена знает домен, а номер строки в таблице
//и текст сообщения — дело того, кто эту строку читал.
export function unknownQueryFields(fields: QueryFieldMap): string[] {
    return Object.keys(fields).filter(field => !(field in SERVER_QUERY_FIELDS));
}

//Итог опроса сервера целиком — всех его источников сразу, в отличие от ServerQueryResult,
//который отдаёт один источник. Разделяет два факта, до появления нескольких источников
//неотличимых и потому слитых в одном `undefined`:
//  alive — ответил ли ГЛАВНЫЙ источник; только он решает online/offline и растит failedChecks;
//  info  — что удалось узнать, слияние ответов всех ответивших источников.
//Смысл разделения: отказ второстепенного источника обедняет info, но alive не трогает —
//сервер жив, просто длина очереди в этот раз неизвестна.
export interface ServerPollResult {
    alive: boolean;
    info: ServerQueryResult;
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

//Сужение конфига до варианта, который умеет данный querier. Querier получает ServerQueryConfig
//целиком, потому что интерфейс общий, и раньше делал `config as A2sQueryConfig` без проверки:
//чужой конфиг падал бы где-то внутри протокольной библиотеки с невнятным текстом. Реестр по type
//защищает от этого при верной проводке, но проводка — код, и ошибиться в ней можно.
export function narrowQueryConfig<T extends ServerQueryConfig["type"]>(
    config: ServerQueryConfig,
    type: T,
): Extract<ServerQueryConfig, {type: T}> {
    if (config.type !== type) {
        throw new Error(`Querier for "${type}" received a "${config.type}" query config`);
    }

    return config as Extract<ServerQueryConfig, {type: T}>;
}
