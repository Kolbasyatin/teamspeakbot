import type {Logger} from "pino";
import type {Permission} from "../access/Roles.js";

//Журнал всего, что люди просят у бота (итерация 23): каждая команда и кнопка с решением стража.
//Нужен, чтобы видеть историю отношений чата и бота (/chats <chat_id>): что человек пробовал,
//что ему не дали, когда он перестал пользоваться.

export interface CommandEntry {
    chatId: number;
    //Кто именно нажал: в группе это не чат. Пост канала — без автора.
    userId: number | undefined;
    kind: "command" | "button";
    //Имя команды без «/» или данные кнопки.
    name: string;
    arguments: string | undefined;
    //undefined — команды нет в карте прав (незнакомая), такую страж молча пропускает мимо.
    permission: Permission | undefined;
    allowed: boolean;
}

export interface CommandJournalStore {
    saveCommand(entry: CommandEntry): Promise<void>;
}

//Глазами стража — одна операция, синхронная: запись идёт в фоне и ответ человеку не задерживает.
export interface CommandRecorder {
    record(entry: CommandEntry): void;
}

//Пределы колонок telegram_command_log (миграция 013). Обрезаем здесь, а не надеемся на строгость
//режима MariaDB: длинный аргумент не должен ни ронять запись, ни зависеть от sql_mode.
const NAME_LIMIT = 64;
const ARGUMENTS_LIMIT = 255;

export function normalizeEntry(entry: CommandEntry): CommandEntry {
    const args = entry.arguments?.trim();

    return {
        ...entry,
        name: entry.name.slice(0, NAME_LIMIT),
        arguments: args ? (args.length > ARGUMENTS_LIMIT ? `${args.slice(0, ARGUMENTS_LIMIT - 1)}…` : args) : undefined,
    };
}

export class CommandJournal implements CommandRecorder {
    constructor(
        private readonly store: CommandJournalStore,
        private readonly logger: Logger,
    ) {
    }

    //Отказ записи — только в лог: из-за журнала команда не должна не сработать.
    public record(entry: CommandEntry): void {
        void this.store.saveCommand(normalizeEntry(entry)).catch((error: unknown) => {
            this.logger.warn({error, chatId: entry.chatId, name: entry.name}, "Не удалось записать команду в журнал");
        });
    }
}
