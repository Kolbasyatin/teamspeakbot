import {TeamSpeak} from "ts3-nodejs-library";
import type {TeamSpeakProperties} from "../properties.js";
import type {NotificationEvent, NotificationHandler} from "./Notifiers.js";
import {log} from "../logger.js";
import {TeamSpeakRender} from "../a2s/TeamSpeakRender.js";

export class TSNotifier implements NotificationHandler {
    private teamSpeak: TeamSpeak | undefined;

    constructor(
        private readonly properties: TeamSpeakProperties,
        private activeFlag: boolean,
        private channelsNotifyNames: string[]
    ) {
    }

    public async notify(event: NotificationEvent): Promise<void> {
        if (event.type !== "statusViewChanged") {
            return;
        }
        //TODO: вынести в конструктор при случае.
        const description = TeamSpeakRender.render(event.view);
        void await this.connection();
        const teamSpeak = this.teamSpeak;
        if (!teamSpeak) {
            throw new Error("Нет TeamSpeak клиента");
        }
        void await teamSpeak.useBySid("1");
        await Promise.allSettled(
            this.channelsNotifyNames.map(channelName =>
                this.editChannel(channelName, description)
            )
        )
    }

    public async close(): Promise<void> {
        if (!this.teamSpeak) {
            return;
        }

        const teamSpeak = this.teamSpeak;
        this.teamSpeak = undefined;

        const closed = new Promise<void>((resolve, reject) => {
            teamSpeak.once("close", error => {
                if (error) {
                    reject(error);
                    return;
                }
                log.info("Штатное закрытие ts shell")
                resolve();
            });
        });

        const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("TeamSpeak close timeout")), 10_000);
        });

        try {
            await teamSpeak.quit();
            await Promise.race([closed, timeout]);
        } catch (error) {
            log.error(error);
            teamSpeak.forceQuit();
            throw error;
        }
    }

    isActive(): boolean {
        return this.activeFlag;
    }

    private async connection(): Promise<void> {
        if (!this.teamSpeak) {
            this.teamSpeak = await TeamSpeak.connect(this.properties);
        }
    }

    private async editChannel(channelName: string, text: string) {
        const channel = await this.teamSpeak?.getChannelByName(channelName);
        if (!channel) {
            throw new Error("Channel not found")
        }
        void await this.teamSpeak?.channelEdit(channel, {
            channelDescription: text
        });
    }
}

