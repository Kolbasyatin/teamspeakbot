import {ClientType} from "ts3-nodejs-library";
import type {TeamSpeakConnection} from "./TeamSpeakConnection.js";

//Единственное место, которое работает с библиотекой TeamSpeak. Потребители зовут операции,
//про соединение под ними не знают.
export class TeamSpeakClient {
    constructor(private readonly connection: TeamSpeakConnection) {
    }

    //Никнеймы живых клиентов, query-клиенты (в том числе мы сами) отброшены.
    public async listOnlineNicknames(): Promise<string[]> {
        const teamSpeak = await this.connection.query();
        const clients = await teamSpeak.clientList({clientType: ClientType.Regular});

        return clients
            .filter(client => !client.isQuery())
            .map(client => client.nickname)
            .sort((left, right) => left.localeCompare(right, "ru"));
    }

    public async editChannelDescription(channelName: string, description: string): Promise<void> {
        const teamSpeak = await this.connection.query();
        const channel = await teamSpeak.getChannelByName(channelName);

        if (!channel) {
            throw new Error(`Channel not found: ${channelName}`);
        }

        void await teamSpeak.channelEdit(channel, {
            channelDescription: description,
        });
    }
}
