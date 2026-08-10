import type {NotificationEvent, NotificationEventOf, Notifier} from "../notifications/events.js";
import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";
import type {PlayerHistory} from "./PlayerHistory.js";
import {detectRoundFinish, isEpisodeOver, type RoundFinishRule} from "./detectRoundFinish.js";

//Куда публикуем. Ровно сигнатура NotificationDispatcher.notify, но без зависимости от него —
//как StatePublisher у StateSync.
export interface RoundFinishPublisher {
    notify(event: NotificationEvent): Promise<void>;
}

export interface RoundFinishOptions extends RoundFinishRule {
    windowMs: number;
    emptyPlayers: number;
}

//Наблюдатель за концом раунда: обычный потребитель события «серверы опрошены».
//
//Дополнительного опроса не делает — берёт игроков из того же события, что и табло TeamSpeak.
//Про Telegram, подписки и текст не знает ничего: его дело — заметить и сказать «похоже, вот это».
//Публикация события потребителем не нова, так же устроен StateSync.
//
//В ServerProbe этого нет намеренно: мониторинг не должен знать, что такое раунд.
export class RoundFinishWatcher implements Notifier<"serverStateUpdated"> {
    //Сервер, по которому уже сигналили в текущем эпизоде. Без этого сообщение уходило бы
    //на каждом замере спада — а он длится полминуты.
    private readonly silenced = new Set<number>();

    constructor(
        private readonly history: PlayerHistory,
        private readonly publisher: RoundFinishPublisher,
        private readonly options: RoundFinishOptions,
        //Время параметром, а не Date.now() внутри: иначе правило не проверить тестом.
        private readonly now: () => number,
    ) {
    }

    public async notify(event: NotificationEventOf<"serverStateUpdated">): Promise<void> {
        const at = this.now();

        for (const snapshot of event.snapshots) {
            await this.observe(snapshot, at);
        }
    }

    private async observe(snapshot: ServerProbeSnapshot, at: number): Promise<void> {
        const serverId = snapshot.config.id;
        const players = snapshot.status === "online" ? snapshot.currentInfo?.players : undefined;

        //Сервер не ответил — замера нет. «Неизвестно» это не ноль, и подмешивать его в историю
        //нельзя: любой пропуск опроса выглядел бы как обвал.
        if (players === undefined) {
            //Уход в offline — это перезапуск. История прошлой сессии к новой отношения не имеет.
            if (snapshot.status === "offline") {
                this.restart(serverId);
            }
            return;
        }

        //Сессия перезапустилась, оставшись доступной: A2S отвечает, а счётчик обнулился.
        //Так бывает, когда сервер перезапускает раунд, всех кикнув, но сам не перезагружается —
        //три случая из 22 в разобранных логах. По offline их не увидеть.
        if (players <= this.options.emptyPlayers) {
            this.restart(serverId);
            return;
        }

        const window = this.history.since(serverId, at - this.options.windowMs);

        this.history.record(serverId, {at, players});

        if (this.silenced.has(serverId)) {
            //Эпизод закрыт — снова слушаем. Возврат к базе, а не таймер: после перезапуска сервер
            //наполняется постепенно, и таймер сработал бы посреди наполнения.
            if (isEpisodeOver(window, players)) {
                this.silenced.delete(serverId);
            }
            return;
        }

        if (!detectRoundFinish(window, players, this.options)) {
            return;
        }

        this.silenced.add(serverId);

        await this.publisher.notify({
            type: "roundFinish",
            snapshot,
            playersBefore: Math.max(...window.map(sample => sample.players)),
        });
    }

    private restart(serverId: number): void {
        this.history.reset(serverId);
        this.silenced.delete(serverId);
    }
}
