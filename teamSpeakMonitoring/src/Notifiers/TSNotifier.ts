import type {NotificationEvent, NotificationHandler} from "./NotificationDispatcher.js";
import {TeamSpeakRender} from "../a2s/TeamSpeakRender.js";

//Нотифаеру нужна одна операция, про соединение и библиотеку TeamSpeak он не знает.
export interface ChannelDescriptionEditor {
    editChannelDescription(channelName: string, description: string): Promise<void>;
}

export class TSNotifier implements NotificationHandler {

    constructor(
        private readonly channelEditor: ChannelDescriptionEditor,
        private readonly channelsNotifyNames: readonly string[],
    ) {
    }

    public async notify(event: NotificationEvent): Promise<void> {
        //Проверка типа нужна, пока NotificationEvent — один union на всех: без неё не сузить тип
        //до statusViewChanged. Уйдёт в итерации 5 вместе с типизацией событий по каналам.
        if (event.type !== "statusViewChanged") {
            return;
        }

        //TODO: рендерер вынести в конструктор — итерация 5, вместе с политикой уведомлений.
        const description = TeamSpeakRender.render(event.view);

        //map запускает правку всех каналов сразу, поэтому Promise.all не мешает остальным каналам
        //обновиться. Но, в отличие от allSettled, отказ виден NotificationDispatcher и попадает в лог.
        await Promise.all(
            this.channelsNotifyNames.map(channelName =>
                this.channelEditor.editChannelDescription(channelName, description),
            ),
        );
    }
}
