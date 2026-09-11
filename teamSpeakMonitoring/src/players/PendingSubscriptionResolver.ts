import type {Logger} from "pino";
import type {ScheduledTask} from "../monitoring/Scheduler.js";
import {PlayerObserverUnavailable, type ObservedPlayer, type PlayerObserver} from "./PlayerObserver.js";
import type {PendingPlayerSubscription} from "../persistence/PlayerSubscriptionRepository.js";

export interface PendingSubscriptionStore {
    findActivePending(now: Date): Promise<PendingPlayerSubscription[]>;

    deleteExpiredPending(now: Date): Promise<number>;

    removePending(chatId: number, nickname: string): Promise<void>;

    subscribe(chatId: number, playerId: number): Promise<void>;
}

//Чем сообщить человеку, что ожидание закрылось. Та же форма, что у остальных уведомлений:
//«отправить текст в чат», про grammy и разметку резолвер не знает.
export interface PendingSubscriptionSink {
    deliver(chatId: number, text: string): Promise<void>;
}

export interface PendingSubscriptionResolverProperties {
    intervalMs: number;
}

//Ожидания «появится игрок с таким ником — подпиши меня». Нужны потому, что пустой ответ поиска
//не означает «такого игрока нет»: наблюдаются не все серверы Reforger, и отличить опечатку
//от «играет вне выборки» нельзя.
//
//Превращаем ожидание в подписку ТОЛЬКО при единственном точном совпадении. Несколько кандидатов —
//выбирать должен человек, а не мы за него: ники не уникальны. Похожие (fuzzy) не годятся тем более:
//это догадка, а подписка на чужого человека хуже, чем отсутствие подписки.
export class PendingSubscriptionResolver implements ScheduledTask {
    public readonly id = "pendingPlayerSubscriptions";

    public constructor(
        private readonly observer: PlayerObserver,
        private readonly store: PendingSubscriptionStore,
        private readonly sink: PendingSubscriptionSink,
        private readonly properties: PendingSubscriptionResolverProperties,
        private readonly logger: Logger,
        private readonly now: () => Date,
    ) {
    }

    public getNextDelayMs(): number {
        return this.properties.intervalMs;
    }

    public async run(): Promise<void> {
        const now = this.now();

        await this.store.deleteExpiredPending(now);

        const pending = await this.store.findActivePending(now);

        for (const item of pending) {
            try {
                await this.resolve(item);
            } catch (error) {
                if (error instanceof PlayerObserverUnavailable) {
                    //Сосед недоступен — остальные ожидания проверять тоже нечем, выходим до
                    //следующего тика. Ожидания не теряются: они в БД.
                    this.logger.warn({error: error.message}, "Не удалось проверить ожидаемых игроков");
                    return;
                }

                this.logger.error({error, chatId: item.chatId}, "Ошибка при проверке ожидаемого игрока");
            }
        }
    }

    private async resolve(item: PendingPlayerSubscription): Promise<void> {
        const result = await this.observer.searchPlayers(item.nickname, 5);

        if (result.fuzzy) {
            return;
        }

        const exact = result.players.filter(player => matchesNickname(player, item.nickname));

        //Ноль — ждём дальше. Больше одного — тёзки, выбирает человек: скажем ему об этом один раз
        //и снимем ожидание, иначе оно будет висеть до истечения срока без всякого шанса закрыться.
        if (exact.length === 0) {
            return;
        }

        await this.store.removePending(item.chatId, item.nickname);

        if (exact.length > 1) {
            await this.sink.deliver(
                item.chatId,
                `Игроков с ником «${item.nickname}» оказалось несколько — выберите нужного: /watch ${item.nickname}`,
            );
            return;
        }

        const [player] = exact;

        if (!player) {
            return;
        }

        await this.store.subscribe(item.chatId, player.playerId);
        await this.sink.deliver(item.chatId, `Игрок «${player.currentNickname}» появился — слежу за ним.`);
        this.logger.info({chatId: item.chatId, playerId: player.playerId}, "Отложенная подписка на игрока закрыта");
    }
}

//Совпадение считается точным, если ник встречался у игрока буквально (регистр не в счёт).
//Поиск отдаёт и подстроки — «Salat» нашёл бы «Salatik», а это другой человек.
function matchesNickname(player: ObservedPlayer, nickname: string): boolean {
    const wanted = nickname.toLowerCase();

    return player.currentNickname.toLowerCase() === wanted
        || player.aliases.some(alias => alias.toLowerCase() === wanted);
}
