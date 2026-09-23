import {ClientType} from "ts3-nodejs-library";
import type {TeamSpeakConnection} from "./TeamSpeakConnection.js";

//Единственное место, которое работает с библиотекой TeamSpeak. Потребители зовут операции,
//про соединение под ними не знают. Каждая операция идёт через connection.run() — с таймаутом,
//см. TeamSpeakConnection.
export class TeamSpeakClient {
    constructor(private readonly connection: TeamSpeakConnection) {
    }

    //Никнеймы живых клиентов, query-клиенты (в том числе мы сами) отброшены.
    public async listOnlineNicknames(): Promise<string[]> {
        const clients = await this.connection.run(
            "clientList",
            teamSpeak => teamSpeak.clientList({clientType: ClientType.Regular}),
        );

        return clients
            .filter(client => !client.isQuery())
            .map(client => client.nickname)
            .sort((left, right) => left.localeCompare(right, "ru"));
    }

    public async editChannelDescription(channelName: string, description: string): Promise<void> {
        await this.connection.run("channelEdit", async teamSpeak => {
            const channel = await teamSpeak.getChannelByName(channelName);

            if (!channel) {
                throw new Error(`Channel not found: ${channelName}`);
            }

            void await teamSpeak.channelEdit(channel, {
                channelDescription: description,
            });
        });
    }
}
