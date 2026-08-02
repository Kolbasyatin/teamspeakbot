import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";

//Единственное место, которое решает, как состояние серверов выглядит в описании канала.
//Проекция снапшота в строки живёт здесь, а не в мониторе: какие поля важны — свойство этого
//табло, а не системы. Другой потребитель тех же снапшотов покажет другое.
export class ChannelDescriptionRenderer {

    //Текст целиком — то, что уходит в канал.
    public static render(snapshots: readonly ServerProbeSnapshot[]): string {
        const updatedAt = new Intl.DateTimeFormat("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZone: "Europe/Moscow",
        }).format(new Date());

        return `${this.renderBody(snapshots)}\n\nОбновлено: ${updatedAt}`;
    }

    //Тот же текст без отметки времени. Нужен для дедупликации: вопрос «переписывать ли описание»
    //эквивалентен вопросу «изменится ли то, что увидит человек», а сравнивать текст целиком нельзя —
    //время в нём меняется каждую секунду, и совпадений не было бы никогда.
    //Побочная выгода: поле, которого в описании нет, на дедупликацию не влияет физически.
    public static renderBody(snapshots: readonly ServerProbeSnapshot[]): string {
        return snapshots
            .map(server => {
                const name = server.config.name;

                if (server.status === "offline") {
                    return `[color=#FF5C5C]${name}: offline[/color]`;
                }

                const players = server.currentInfo?.players;
                const maxPlayers = server.currentInfo?.maxPlayers;

                if (players === undefined || maxPlayers === undefined) {
                    return `[color=#FFD166]${name}: unknown[/color]`;
                }

                return `[color=#66FF99]${name}: ${players}/${maxPlayers}[/color]`;
            })
            .join("\n");
    }
}
