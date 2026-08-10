import type {Notifier, NotificationEventOf} from "./events.js";

//Одна операция, как и у TelegramStatusNotifier: адресата подставляет composition root.
export interface MessageSender {
    send(text: string): Promise<void>;
}

//Текст сигнала о конце раунда. Отдельный класс от TelegramStatusNotifier, потому что это другая
//логика доставки: там переходы статуса и своя дедупликация, здесь однократный прогноз.
//
//Дедупликацией НЕ оборачивается намеренно. Во-первых, повторов не бывает — наблюдатель сигналит
//один раз на эпизод. Во-вторых, сигнал ценен полторы минуты: повторить упавшую доставку через
//минуту значит сказать «скоро освободится» тогда, когда уже освободилось и заполнилось снова.
export class RoundFinishNotifier implements Notifier<"roundFinish"> {
    constructor(private readonly sender: MessageSender) {
    }

    public async notify(event: NotificationEventOf<"roundFinish">): Promise<void> {
        const maxPlayers = event.snapshot.currentInfo?.maxPlayers;
        const players = event.snapshot.currentInfo?.players;

        await this.sender.send([
            `⏳ ${event.snapshot.config.name}`,
            `Похоже, раунд заканчивается: было ${event.playersBefore}` +
            (players === undefined ? "" : `, стало ${players}${maxPlayers === undefined ? "" : `/${maxPlayers}`}`),
            "Самое время начать ебланить.",
        ].join("\n"));
    }
}
