import type {Notifier, NotificationEventOf} from "./events.js";
import {ChannelDescriptionRenderer} from "../teamspeak/ChannelDescriptionRenderer.js";

//Нотифаеру нужна одна операция, про соединение и библиотеку TeamSpeak он не знает.
export interface ChannelDescriptionEditor {
    editChannelDescription(channelName: string, description: string): Promise<void>;
}

//Подписан на оба события с состоянием: описание канала — табло, и ему одинаково нужны
//и «серверы опрошены», и «состояние публикуется принудительно». Различать их внутри нечего:
//работа одна — отрендерить и записать. Отличаются они снаружи, обёрткой: первое проходит
//через дедупликацию, второе идёт мимо неё.
type ViewEvent = "serverStateUpdated" | "serverStateRepublished";

export class TeamSpeakChannelNotifier implements Notifier<ViewEvent> {

    constructor(
        private readonly channelEditor: ChannelDescriptionEditor,
        private readonly channelsNotifyNames: readonly string[],
    ) {
    }

    public async notify(event: NotificationEventOf<ViewEvent>): Promise<void> {
        //TODO: рендерер вынести в конструктор, когда у уведомлений появится своя политика.
        const description = ChannelDescriptionRenderer.render(event.snapshots);

        //map запускает правку всех каналов сразу, поэтому Promise.all не мешает остальным каналам
        //обновиться. Но, в отличие от allSettled, отказ виден NotificationDispatcher и попадает в лог.
        await Promise.all(
            this.channelsNotifyNames.map(channelName =>
                this.channelEditor.editChannelDescription(channelName, description),
            ),
        );
    }
}
