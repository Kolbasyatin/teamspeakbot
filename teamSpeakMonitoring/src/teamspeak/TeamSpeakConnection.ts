import {TeamSpeak} from "ts3-nodejs-library";
import type {TeamSpeakProperties} from "../properties.js";
import type {Logger} from "pino";

//Операция TeamSpeak не уложилась в таймаут. Отдельный класс, чтобы вызывающий мог отличить
//«TeamSpeak не ответил» от ошибки самой команды.
export class TeamSpeakTimeoutError extends Error {
    constructor(operation: string, timeoutMs: number) {
        super(`TeamSpeak operation "${operation}" timed out after ${timeoutMs} ms`);
        this.name = "TeamSpeakTimeoutError";
    }
}

//Одно долгоживущее query-подключение на процесс. Занимается только жизненным циклом,
//операции над сервером лежат в TeamSpeakClient.
//
//ТАЙМАУТ — главное, что здесь есть сверх жизненного цикла. У ts3-nodejs-library нет таймаута
//на команду: промис разрешается только ответом сервера. А при закрытии сокета библиотека ставит
//очередь на паузу и НЕ отклоняет ни текущую команду, ни ожидающие — их промисы не разрешатся
//никогда. Раньше так зависал /who, а вместе с ним весь приём команд бота: grammy не зовёт
//следующий getUpdates, пока не отработал обработчик. Поэтому каждая операция идёт через run()
//с потолком, а соединение, на котором операция не уложилась, выбрасывается: доверять ему больше
//нельзя, в его очереди застряла команда, и всё, что встанет за ней, повиснет тоже.
export class TeamSpeakConnection {
    private teamSpeak: TeamSpeak | undefined;
    private connecting: Promise<TeamSpeak> | undefined;

    constructor(
        private readonly properties: TeamSpeakProperties,
        private readonly logger: Logger,
        private readonly timeoutMs: number,
        private readonly virtualServerId: string = "1",
        //Подключение отдельной функцией ради теста: зависание проверяется без живого TeamSpeak.
        private readonly connectTo: (properties: TeamSpeakProperties) => Promise<TeamSpeak> =
            properties => TeamSpeak.connect(properties),
    ) {
    }

    //Операция над сервером с потолком по времени. Потолок общий на подключение и команды:
    //вызывающему всё равно, на каком шаге завис TeamSpeak.
    public async run<T>(operation: string, action: (teamSpeak: TeamSpeak) => Promise<T>): Promise<T> {
        let used: TeamSpeak | undefined;
        const work = this.query().then(teamSpeak => {
            used = teamSpeak;
            return action(teamSpeak);
        });
        //Проигравшая гонку операция может отклониться позже — это уже никому не интересно,
        //но без обработчика ушло бы в unhandled rejection.
        work.catch(() => undefined);

        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new TeamSpeakTimeoutError(operation, this.timeoutMs)), this.timeoutMs);
        });

        try {
            return await Promise.race([work, timeout]);
        } catch (error) {
            if (error instanceof TeamSpeakTimeoutError) {
                this.logger.warn({operation, timeoutMs: this.timeoutMs}, "TeamSpeak не ответил вовремя, соединение сбрасывается");
                this.discard(used);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    //Приватный намеренно: операция в обход run() осталась бы без таймаута.
    private async query(): Promise<TeamSpeak> {
        if (this.teamSpeak) {
            return this.teamSpeak;
        }

        //Poll нотифаера и команда бота могут прийти одновременно, коннектимся при этом один раз.
        this.connecting ??= this.connect();

        try {
            return await this.connecting;
        } finally {
            this.connecting = undefined;
        }
    }

    public async close(): Promise<void> {
        const teamSpeak = this.teamSpeak;
        if (!teamSpeak) {
            return;
        }

        this.teamSpeak = undefined;

        const closed = new Promise<void>((resolve, reject) => {
            teamSpeak.once("close", error => {
                if (error) {
                    reject(error);
                    return;
                }
                this.logger.info("Штатное закрытие ts shell");
                resolve();
            });
        });

        const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("TeamSpeak close timeout")), 10_000);
        });

        try {
            void await teamSpeak.quit();
            void await Promise.race([closed, timeout]);
        } catch (error) {
            this.logger.error({error}, "Не удалось штатно закрыть ts shell");
            teamSpeak.forceQuit();
            throw error;
        }
    }

    //Выбросить соединение, которому больше нельзя доверять. Следующий run() подключится заново.
    //Сравнение с текущим обязательно: пока операция висела, соединение могло уже смениться,
    //и сносить новое, здоровое, незачем.
    private discard(teamSpeak: TeamSpeak | undefined): void {
        if (!teamSpeak || this.teamSpeak !== teamSpeak) {
            return;
        }

        this.teamSpeak = undefined;

        try {
            void teamSpeak.forceQuit();
        } catch (error) {
            //Сокет мог уже быть закрыт — тогда и закрывать нечего.
            this.logger.debug({error}, "forceQuit на сброшенном соединении TeamSpeak не прошёл");
        }
    }

    private async connect(): Promise<TeamSpeak> {
        const teamSpeak = await this.connectTo(this.properties);
        //Выбранный виртуальный сервер живет до конца сессии, поэтому делаем это один раз на подключение.
        void await teamSpeak.useBySid(this.virtualServerId);

        //Соединение может отвалиться между обращениями, тогда следующий client() переподключится.
        teamSpeak.once("close", () => {
            if (this.teamSpeak !== teamSpeak) {
                return;
            }
            this.teamSpeak = undefined;
            this.logger.warn("ts shell закрыт, следующее обращение переподключится");
        });

        this.teamSpeak = teamSpeak;

        return teamSpeak;
    }
}
