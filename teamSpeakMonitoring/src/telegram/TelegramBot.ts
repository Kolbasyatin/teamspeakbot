import type {Bot} from "grammy";
import type {ServerProbeSnapshot} from "../monitoring/ServerProbe.js";
import {formatDuration, intervalToDuration,} from "date-fns";
import {ru} from "date-fns/locale";
import {log} from "../logger.js";

//Боту нужно только читать состояние серверов, весь ServerMonitor ему знать незачем.
export interface StatusSource {
    getSnapshot(): ServerProbeSnapshot[];
}

//Аналогично по TeamSpeak: боту нужен только список никнеймов, соединение не его забота.
export interface OnlineNicknamesSource {
    listOnlineNicknames(): Promise<string[]>;
}

export class TelegramBot {
    //Bot создаётся в composition root и делится с отправкой уведомлений: один long-polling
    //и один api-клиент на процесс.
    constructor(
        private readonly bot: Bot,
        private readonly statusSource: StatusSource,
        private readonly nicknamesSource: OnlineNicknamesSource
    ) {
        this.registerCommands();
    }

    public start(): void {
        void this.bot.start();
    }

    public async stop(): Promise<void> {
        await this.bot.stop();
    }

    private registerCommands(): void {
        this.bot.command("time", async ctx => {
            await ctx.reply(this.showTime(this.statusSource.getSnapshot()));
        })
        this.bot.command("who", async ctx => {
            await ctx.reply(await this.showWho());
        })
        this.bot.command("id", async ctx => {
            await ctx.reply(`chatId: ${ctx.chatId}`);
        });
    }

    private async showWho(): Promise<string> {
        try {
            const nicknames = await this.nicknamesSource.listOnlineNicknames();

            if (nicknames.length === 0) {
                return "В TeamSpeak никого нет";
            }

            return [
                `В TeamSpeak (${nicknames.length}):`,
                ...nicknames.map(nickname => `• ${nickname}`),
            ].join("\n");
        } catch (error) {
            log.error({error}, "Не удалось получить список клиентов TeamSpeak");
            return "Не удалось получить список из TeamSpeak";
        }
    }

    private showTime(snapshots: ServerProbeSnapshot[]): string {
        if (snapshots.length === 0) {
            return "Нет отслеживаемых серверов";
        }

        return snapshots
            .map(server => {
                const now = new Date();
                const duration = formatDuration(intervalToDuration({start: server.statusSince, end: now}), {
                    locale: ru,
                    format: ["hours", "minutes", "seconds"],
                    zero: true
                })
                return `${server.config.name}: ${server.status}, ${duration}`;
            })
            .join("\n");
    }
}