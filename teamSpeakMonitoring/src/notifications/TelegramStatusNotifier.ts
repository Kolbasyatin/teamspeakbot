import type {Notifier, NotificationEventOf} from "./events.js";
import {escapeHtml} from "../telegram/escapeHtml.js";

//Нотифаеру нужна одна операция — отправить текст. Про grammy, chatId и про то, что транспорт
//именно Telegram, он не знает: интерфейс объявлен здесь, у потребителя.
export interface MessageSender {
    send(text: string): Promise<void>;
}

//События, которые обслуживает этот нотифаер: переходы статуса сервера.
export type ServerStatusEventType = "serverOnline" | "serverOffline";

//Метка и текст на каждое событие. Record, а не Map или switch: компилятор требует запись
//для КАЖДОГО события из ServerStatusEventType. Добавишь событие в объединение — сборка упадёт,
//пока не появится его текст. Забыть нельзя.
//
//Цвет — это метка, а не текст: красить слова Telegram не умеет ни в HTML, ни в Markdown.
//Метки те же, что у сводки /status (STATUS_MARK), чтобы уведомление и сводка читались одинаково.
//В терминале и IDE 🟢 может выглядеть серым: круг добавлен в Unicode в 2019-м, и старые шрифты
//рисуют заглушку. В Telegram набор эмодзи свой, там он зелёный.
//TODO: когда понадобятся разные шаблоны и разметка, таблица уедет за рендерер —
//он будет собирать текст, а нотифаер останется только доставкой.
const STATUS_TEXT: Record<ServerStatusEventType, {mark: string; text: string}> = {
    serverOnline: {mark: "🟢", text: "is online"},
    serverOffline: {mark: "🔴", text: "is offline"},
};

//Один нотифаер на все переходы статуса. Раньше это были два класса, отличавшиеся одним словом
//в шаблоне: расширение шло по классам вместо строк таблицы.
export class TelegramStatusNotifier implements Notifier<ServerStatusEventType> {
    constructor(private readonly sender: MessageSender) {
    }

    public async notify(event: NotificationEventOf<ServerStatusEventType>): Promise<void> {
        const {mark, text} = STATUS_TEXT[event.type];

        //Имя жирным, чтобы в ленте уведомлений глаз цеплялся за сервер, а не за одинаковое «is online».
        await this.sender.send(`${mark} <b>${escapeHtml(event.snapshot.config.name)}</b> ${text}`);
    }
}
