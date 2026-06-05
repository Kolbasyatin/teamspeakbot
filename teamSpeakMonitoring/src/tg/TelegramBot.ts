import {Bot} from "grammy";
import type {ServerMonitor} from "../a2s/ServerMonitor.js";
import type {ServerSnapshot} from "../a2s/ServerProbe.js";
import {formatDuration, intervalToDuration,} from "date-fns";
import {ru} from "date-fns/locale";

export class TelegramBot {
    private readonly bot: Bot;

    constructor(
        token: string,
        // private readonly channelId: string,
        private readonly monitor: ServerMonitor
    ) {
        this.bot = new Bot(token);
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
            await ctx.reply(this.showTime(this.monitor.getSnapshot()));
        })
        this.bot.command("id", async ctx => {
            await ctx.reply(`chatId: ${ctx.chatId}`);
        });
    }

    private showTime(snapshots: ServerSnapshot[]): string {
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