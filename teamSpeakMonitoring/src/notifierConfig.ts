import "dotenv-flow/config";
import convict from "convict";

export interface NotifierConfig {
    teamspeak: boolean;
    log: boolean;
    telegram: boolean;
}

const config = convict<NotifierConfig>({
    teamspeak: {
        doc: "Enable TeamSpeak notifier",
        format: Boolean,
        default: false,
        env: "TEAMSPEAK_NOTIFIER",
    },
    log: {
        doc: "Enable log notifier",
        format: Boolean,
        default: true,
        env: "LOG_NOTIFIER",
    },
    telegram: {
        doc: "Enable telegram notifier",
        format: Boolean,
        default: false,
        env: "TELEGRAM_NOTIFIER",
    },
});

config.validate({allowed: "strict"});

export const notifierConfig = config.getProperties();
