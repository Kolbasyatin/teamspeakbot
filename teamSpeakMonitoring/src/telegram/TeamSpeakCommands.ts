import type {Bot} from "grammy";
import type {BotCommand} from "grammy/types";
import {log} from "../logger.js";
import type {BotCommands} from "./TelegramBot.js";

//Боту нужен только список никнеймов, соединение с TeamSpeak не его забота.
export interface OnlineNicknamesSource {
    listOnlineNicknames(): Promise<string[]>;
}

//Всё, что бот умеет про TeamSpeak. Пока одна команда — /who.
//
//Раньше класс назывался StatusCommands и держал ещё /time и /id. /time уехал в SubscriptionCommands
//синонимом /status: он показывал все опрашиваемые серверы, то есть чужие подписки. /id удалён —
//он был отладочным, чтобы узнать chat_id вручную.
export class TeamSpeakCommands implements BotCommands {
    constructor(
        private readonly nicknamesSource: OnlineNicknamesSource,
    ) {
    }

    public register(bot: Bot): void {
        bot.command("who", async ctx => {
            await ctx.reply(await this.showWho());
        });
    }

    public describe(): BotCommand[] {
        return [
            {command: "who", description: "кто сейчас в TeamSpeak"},
        ];
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
}
