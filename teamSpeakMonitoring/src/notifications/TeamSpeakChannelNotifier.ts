import type {Notifier, NotificationEventOf} from "./events.js";
import {ChannelDescriptionRenderer} from "../teamspeak/ChannelDescriptionRenderer.js";

//Нотифаеру нужна одна операция, про соединение и библиотеку TeamSpeak он не знает.
export interface ChannelDescriptionEditor {
    editChannelDescription(channelName: string, description: string): Promise<void>;
}

export class TeamSpeakChannelNotifier implements Notifier<"statusViewChanged"> {

    constructor(
        private readonly channelEditor: ChannelDescriptionEditor,
        private readonly channelsNotifyNames: readonly string[],
    ) {
    }

    public async notify(event: NotificationEventOf<"statusViewChanged">): Promise<void> {
        //TODO: рендерер вынести в конструктор, когда у уведомлений появится своя политика.
        const description = ChannelDescriptionRenderer.render(event.view);

        //map запускает правку всех каналов сразу, поэтому Promise.all не мешает остальным каналам
        //обновиться. Но, в отличие от allSettled, отказ виден NotificationDispatcher и попадает в лог.
        await Promise.all(
            this.channelsNotifyNames.map(channelName =>
                this.channelEditor.editChannelDescription(channelName, description),
            ),
        );
    }
}
