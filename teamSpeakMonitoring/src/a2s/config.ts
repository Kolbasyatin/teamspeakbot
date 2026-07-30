export type ServerMonitorConfig = {
    id: number;
    name: string;
    gameAddress: string;
    query: ServerQueryConfig;
};

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


//Все перенесено в БД. Оставил для примера.
export const servers: ServerMonitorConfig[] = [
    {
        id: 1,
        name: '#1 ARMA-RUSSIAN.RU',
        gameAddress: '37.48.253.41:2001',
        query: {
            type: "a2s",
            host: "37.48.253.41",
            port: 17771,
            timeout: 5000
        }
    },
    {
        id: 3,
        name: '#3 ARMA-RUSSIAN.RU',
        gameAddress: '37.48.253.41:2003',
        query: {
            type: "a2s",
            host: "37.48.253.41",
            port: 17773,
            timeout: 5000
        }
    },
    {
        id: 5,
        name: '#5 ARMA-RUSSIAN.RU',
        gameAddress: '37.48.253.91:2004',
        query: {
            type: "a2s",
            host: "37.48.253.91",
            port: 17775,
            timeout: 5000
        }
    },
    {
        id: 6,
        name: '#1 ARMA.PLANESET.RU',
        gameAddress: '93.157.244.250:2001',
        query: {
            type: "a2s",
            host: "93.157.244.250",
            port: 17777,
            timeout: 5000
        }
    }
];
