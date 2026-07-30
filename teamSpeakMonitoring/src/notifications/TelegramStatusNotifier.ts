import type {Notifier, NotificationEventOf} from "./events.js";

//Нотифаеру нужна одна операция — отправить текст. Про grammy, chatId и про то, что транспорт
//именно Telegram, он не знает: интерфейс объявлен здесь, у потребителя.
export interface MessageSender {
    send(text: string): Promise<void>;
}

//События, которые обслуживает этот нотифаер: переходы статуса сервера.
export type ServerStatusEventType = "serverOnline" | "serverOffline";

//Текст на каждое событие. Record, а не Map или switch: компилятор требует запись для КАЖДОГО
//события из ServerStatusEventType. Добавишь событие в объединение — сборка упадёт, пока
//не появится его текст. Забыть нельзя.
//TODO: когда понадобятся разные шаблоны и разметка, таблица уедет за рендерер —
//он будет собирать текст, а нотифаер останется только доставкой.
const STATUS_TEXT: Record<ServerStatusEventType, string> = {
    serverOnline: "is online",
    serverOffline: "is offline",
};

//Один нотифаер на все переходы статуса. Раньше это были два класса, отличавшиеся одним словом
//в шаблоне: расширение шло по классам вместо строк таблицы.
export class TelegramStatusNotifier implements Notifier<ServerStatusEventType> {
    constructor(private readonly sender: MessageSender) {
    }

    public async notify(event: NotificationEventOf<ServerStatusEventType>): Promise<void> {
        await this.sender.send(`${event.snapshot.config.name} ${STATUS_TEXT[event.type]}`);
    }
}
