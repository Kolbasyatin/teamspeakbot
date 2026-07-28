import {TeamSpeak} from "ts3-nodejs-library";
import type {TeamSpeakProperties} from "../properties.js";
import type {Logger} from "pino";

//Одно долгоживущее query-подключение на процесс. Занимается только жизненным циклом,
//операции над сервером лежат в TeamSpeakClient.
export class TeamSpeakConnection {
    private teamSpeak: TeamSpeak | undefined;
    private connecting: Promise<TeamSpeak> | undefined;

    constructor(
        private readonly properties: TeamSpeakProperties,
        private readonly logger: Logger,
        private readonly virtualServerId: string = "1",
    ) {
    }

    public async query(): Promise<TeamSpeak> {
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

    private async connect(): Promise<TeamSpeak> {
        const teamSpeak = await TeamSpeak.connect(this.properties);
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
