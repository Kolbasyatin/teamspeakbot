import type {ServerQueryConfig} from "./ServerQuery.js";

//Роль источника. Назначается руками и отвечает ровно на один вопрос: чей ответ решает online/offline.
//Не то же самое, что priority, и схлопывать их нельзя: надёжность как индикатора жизни и богатство
//данных — разные качества. A2S надёжно показывает, что сервер жив, но отдаёт только players;
//REST с длиной очереди может лежать сам по себе при живом игровом сервере. Отсюда рабочая
//комбинация: primary = A2S, а по приоритету данных REST стоит выше.
export type ServerQueryRole = "primary" | "secondary";

//Один источник опроса сервера. Отключённые сюда не доезжают — их отсеивает репозиторий.
export type ServerQuerySource = {
    id: number;
    role: ServerQueryRole;
    //Меньше — важнее. Одно и то же число задаёт и порядок в sources, и порядок слияния
    //в mergeQueryResults: первое определённое значение поля выигрывает.
    priority: number;
    query: ServerQueryConfig;
};

//Сервер и его включённые источники — ровно то, что обязано отдать хранилище, и ничего сверх того.
//Контракт объявлен здесь, в домене, а не в persistence: чтобы поменять MariaDB на SQLite,
//достаточно написать чтение, отдающее эту форму. Никаких доменных решений реализация
//не принимает — их принимает buildMonitorConfigs.
//gameAddress — адрес для игроков, в опросе не используется.
export type StoredServer = {
    id: number;
    name: string;
    gameAddress: string;
    //Порядок не важен: сортировкой по приоритету занимается домен, чтобы забытый ORDER BY
    //в новой реализации не менял молча порядок слияния данных.
    sources: ServerQuerySource[];
};

//Готовый к опросу сервер. От StoredServer отличается двумя гарантиями, которые даёт
//buildMonitorConfigs: источники упорядочены и главный из них уже выбран.
export type ServerMonitorConfig = {
    id: number;
    name: string;
    gameAddress: string;
    //Здесь порядок уже значим: он же уходит в слияние, где выигрывает первое определённое поле.
    sources: ServerQuerySource[];
    //Кто определяет статус. Это ССЫЛКА на элемент sources, а не отдельная копия.
    //Отдельным полем, а не вычислением на месте использования, ради инварианта:
    //«главный источник есть всегда» становится фактом, который проверяет компилятор.
    //Иначе каждый потребитель — включая pollProbe — обязан разбирать ветку undefined,
    //хотя серверы без источников отсеяны ещё при сборке.
    primarySource: ServerQuerySource;
};

//Шпаргалка по тому, что вносить в БД. Раньше здесь лежал массив-пример реальных серверов,
//но он был мёртвым кодом: настоящий список живёт в monitored_servers.
//
//monitored_servers — сам сервер:
//  id           bigint unsigned  auto_increment
//  name         '#1 ARMA-RUSSIAN.RU'      как показывать сервер в описании канала и в Telegram
//  game_address '37.48.253.41:2001'       адрес для игроков (в опросе не участвует)
//  enabled      tinyint(1)                отключает мониторинг, не удаляя строку
//
//server_query_sources — чем его опрашивать, одна строка на источник:
//  server_id    bigint unsigned           ссылка на monitored_servers.id
//  role         'primary' | 'secondary'   primary решает online/offline
//  priority     int                       меньше — важнее; порядок слияния данных
//  query_type   'a2s' | 'rest'            должен совпадать с полем type внутри query_config
//  query_config JSON, сериализованный ServerQueryConfig:
//                 {"type":"a2s","host":"37.48.253.41","port":17771,"timeout":5000}
//                 {"type":"rest","url":"https://example.com/status","timeout":5000}
//  enabled      tinyint(1)                отключает источник, не удаляя строку
//
//Порт в query_config — это порт A2S-запроса, он не равен игровому порту из game_address
//(например, игровой 2001 против A2S 17771).
//Отключать primary можно: главным станет самый приоритетный из оставшихся включённых.
//Сервер, у которого не осталось ни одного включённого источника, не опрашивается вовсе.
//После правки таблиц нужно дёрнуть POST /internal/reload-servers, а если менялись поля
//существующей строки — POST /internal/force-reload-servers.
