//Короткая история числа игроков по каждому серверу — то, на чём детектор видит спад.
//
//За интерфейсом, потому что реализаций будет две с разными задачами: детектору хватает окна
//в минуту в памяти, а графикам нужен ряд, переживающий рестарт. См. telegram.md, §11.

export interface PlayerSample {
    at: number;
    players: number;
}

export interface PlayerHistory {
    //Записать замер. Сервер, который не ответил, замера не даёт вовсе: «неизвестно» — это не ноль,
    //и подмешивать его в историю нельзя, иначе любой пропуск опроса выглядел бы как обвал.
    record(serverId: number, sample: PlayerSample): void;

    //Замеры не старше since. Порядок — от старых к новым.
    since(serverId: number, at: number): PlayerSample[];

    //Забыть всё по серверу. Вызывается при перезапуске: замеры прошлой сессии не про эту,
    //и по ним возврат сервера с нулём игроков сам выглядел бы как обвал.
    reset(serverId: number): void;
}

//Реализация для детектора: окно в память, старое выбрасывается.
//Потеря истории при рестарте процесса допустима — окно и так короткое, а через минуту
//после старта оно наполнится заново.
export class InMemoryPlayerHistory implements PlayerHistory {
    private readonly samples = new Map<number, PlayerSample[]>();

    constructor(private readonly windowMs: number) {
    }

    public record(serverId: number, sample: PlayerSample): void {
        const kept = (this.samples.get(serverId) ?? []).filter(old => old.at >= sample.at - this.windowMs);

        kept.push(sample);
        this.samples.set(serverId, kept);
    }

    public since(serverId: number, at: number): PlayerSample[] {
        return (this.samples.get(serverId) ?? []).filter(sample => sample.at >= at);
    }

    public reset(serverId: number): void {
        this.samples.delete(serverId);
    }
}
