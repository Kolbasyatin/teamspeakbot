import type {ServerQueryConfig} from "./ServerQuery.js";

//Отслеживаемый сервер: то, что лежит в таблице monitored_servers и из чего ServerMonitor
//делает probe. gameAddress — адрес для игроков, для опроса он не используется.
export type ServerMonitorConfig = {
    id: number;
    name: string;
    gameAddress: string;
    query: ServerQueryConfig;
};

//Шпаргалка по тому, что вносить в БД. Раньше здесь лежал массив-пример реальных серверов,
//но он был мёртвым кодом: настоящий список живёт в monitored_servers.
//
//  id           bigint unsigned  auto_increment
//  name         '#1 ARMA-RUSSIAN.RU'      как показывать сервер в описании канала и в Telegram
//  game_address '37.48.253.41:2001'       адрес для игроков (в опросе не участвует)
//  query_type   'a2s' | 'rest'            должен совпадать с полем type внутри query_config
//  query_config JSON, сериализованный ServerQueryConfig:
//                 {"type":"a2s","host":"37.48.253.41","port":17771,"timeout":5000}
//                 {"type":"rest","url":"https://example.com/status","timeout":5000}
//  enabled      tinyint(1)                отключает мониторинг, не удаляя строку
//
//Порт в query_config — это порт A2S-запроса, он не равен игровому порту из game_address
//(например, игровой 2001 против A2S 17771).
//После правки таблицы нужно дёрнуть POST /internal/reload-servers, а если менялись поля
//существующей строки — POST /internal/force-reload-servers.
