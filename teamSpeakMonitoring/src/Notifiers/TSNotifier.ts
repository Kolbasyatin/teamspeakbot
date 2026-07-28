import type {NotificationEvent, NotificationHandler} from "./Notifiers.js";
import {TeamSpeakRender} from "../a2s/TeamSpeakRender.js";

//Нотифаеру нужна одна операция, про соединение и библиотеку TeamSpeak он не знает.
export interface ChannelDescriptionEditor {
    editChannelDescription(channelName: string, description: string): Promise<void>;
}

export class TSNotifier implements NotificationHandler {

    constructor(
        private readonly channelEditor: ChannelDescriptionEditor,
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
        await Promise.allSettled(
            this.channelsNotifyNames.map(channelName =>
                this.channelEditor.editChannelDescription(channelName, description)
            )
        )
    }

    //Соединением владеет TeamSpeakConnection, закрывает его main при shutdown.
    public async close(): Promise<void> {
        return;
    }

    isActive(): boolean {
        return this.activeFlag;
    }
}

