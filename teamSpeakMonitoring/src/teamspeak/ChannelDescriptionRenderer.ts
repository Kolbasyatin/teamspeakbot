import type {ServerDescriptionView} from "../monitoring/ServerMonitor.js";

export class ChannelDescriptionRenderer {
    public static render(view: ServerDescriptionView[]): string {
        const body = view
            .map(server => {
                if (server.status === "offline") {
                    return `[color=#FF5C5C]${server.name}: offline[/color]`;
                }

                if (server.players === undefined || server.maxPlayers === undefined) {
                    return `[color=#FFD166]${server.name}: unknown[/color]`;
                }

                return `[color=#66FF99]${server.name}: ${server.players}/${server.maxPlayers}[/color]`;
            })
            .join("\n");

        const updatedAt = new Intl.DateTimeFormat("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZone: "Europe/Moscow",
        }).format(new Date());

        return `${body}\n\nОбновлено: ${updatedAt}`
    }
}
