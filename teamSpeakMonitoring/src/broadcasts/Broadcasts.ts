//Рассылки и списки рассылки (итерация 24). Здесь правила и контракты — без Telegram и без SQL:
//кому можно адресовать, как называются списки, что такое итог доставки.
//
//Списки — «кому мы пишем», роли — «что чату можно». Это разные оси: список ничего не разрешает,
//роль никого не адресует. Поэтому списки отдельной сущностью, а не ролями без прав (rbac.md).

//Кому адресована рассылка. all и unsorted встроенные и не хранятся: all — все, кто писал боту
//и не заблокировал его; unsorted — те из них, кто не входит ни в один список (туда попадает
//любой новый чат сам, и уходит оттуда, как только его добавят в список).
export type BroadcastTarget =
    | {kind: "chat"; chatId: number}
    | {kind: "list"; name: string}
    | {kind: "all"}
    | {kind: "unsorted"};

export const RESERVED_TARGETS = ["all", "unsorted"] as const;

//Латиница в нижнем регистре, цифры и «_», с буквы: имя набирают в командах, а число было бы
//неотличимо от chat_id.
const LIST_NAME = /^[a-z][a-z0-9_]{1,31}$/;

export type ListNameProblem = "format" | "reserved";

export function listNameProblem(name: string): ListNameProblem | undefined {
    if ((RESERVED_TARGETS as readonly string[]).includes(name)) {
        return "reserved";
    }

    return LIST_NAME.test(name) ? undefined : "format";
}

//«555», «-1003738458034» — чат; «all», «unsorted» — встроенные; остальное — имя списка.
export function parseTarget(raw: string): BroadcastTarget | undefined {
    const value = raw.trim().toLowerCase();

    if (/^-?\d+$/.test(value)) {
        const chatId = Number(value);
        return Number.isSafeInteger(chatId) ? {kind: "chat", chatId} : undefined;
    }

    if (value === "all" || value === "unsorted") {
        return {kind: value};
    }

    return listNameProblem(value) === undefined ? {kind: "list", name: value} : undefined;
}

//Как адресат хранится в журнале и показывается людям.
export function describeTarget(target: BroadcastTarget): string {
    switch (target.kind) {
        case "chat":
            return `chat:${target.chatId}`;
        case "list":
            return `list:${target.name}`;
        case "all":
        case "unsorted":
            return target.kind;
    }
}

export function targetFromDescription(description: string): BroadcastTarget | undefined {
    if (description.startsWith("chat:")) {
        return parseTarget(description.slice("chat:".length));
    }

    if (description.startsWith("list:")) {
        return parseTarget(description.slice("list:".length));
    }

    return parseTarget(description);
}

//Что рассылается. Копия сообщения автора сохраняет разметку, ссылки и вложения — экранировать
//ничего не надо; простой текст — для коротких объявлений прямо в команде.
export type BroadcastContent =
    | {kind: "copy"; fromChatId: number; messageId: number}
    | {kind: "text"; text: string};

//Итог доставки одному чату. blocked — чат недоступен насовсем (заблокировал бота, удалил аккаунт,
//выгнал бота из группы): в следующие рассылки по спискам он не попадёт. failed — всё остальное.
export type DeliveryOutcome =
    | {status: "delivered"}
    | {status: "blocked"; error: string}
    | {status: "failed"; error: string};

export type BroadcastStatus = "pending" | "sending" | "done" | "cancelled" | "interrupted";

export interface NewBroadcast {
    authorUserId: number;
    authorChatId: number;
    content: BroadcastContent;
    preview: string | undefined;
    target: BroadcastTarget;
}

export interface StoredBroadcast extends NewBroadcast {
    id: number;
    status: BroadcastStatus;
    recipients: number;
    delivered: number;
    blocked: number;
    failed: number;
    createdAt: Date;
    finishedAt: Date | undefined;
}

export interface DeliveryCounts {
    recipients: number;
    delivered: number;
    blocked: number;
    failed: number;
}

export interface BroadcastStore {
    createBroadcast(broadcast: NewBroadcast): Promise<number>;

    findBroadcast(id: number): Promise<StoredBroadcast | undefined>;

    //pending → sending / cancelled. false — рассылка уже не ждёт подтверждения (двойное нажатие,
    //чужая отмена): переход атомарный, второй раз рассылка не уйдёт.
    startBroadcast(id: number): Promise<boolean>;

    cancelBroadcast(id: number): Promise<boolean>;

    //Адресаты на момент запуска. Заблокировавшие бота в списки и all не попадают; адресный
    //чат — попадает: человек мог разблокировать бота, а пишем мы ему намеренно.
    resolveRecipients(target: BroadcastTarget): Promise<number[]>;

    //Пишет итог и ставит или снимает пометку «заблокировал бота».
    recordDelivery(broadcastId: number, chatId: number, outcome: DeliveryOutcome): Promise<void>;

    finishBroadcast(id: number, counts: DeliveryCounts): Promise<void>;

    //При старте: рассылки, оставшиеся «в процессе» после рестарта, честно помечаются прерванными.
    interruptUnfinished(): Promise<number>;

    findRecentBroadcasts(limit: number): Promise<StoredBroadcast[]>;
}

export interface ListMember {
    chatId: number;
    title: string | undefined;
    type: string;
    blocked: boolean;
}

export interface ListSummary {
    name: string;
    description: string | undefined;
    members: number;
}

export interface ListsOverview {
    lists: readonly ListSummary[];
    all: number;
    unsorted: number;
    blocked: number;
}

export interface MembershipChange {
    changed: number[];
    unchanged: number[];
    //Чаты, которых бот не знает: в список можно добавить только тех, кто ему писал.
    unknown: number[];
}

export interface MailingListStore {
    createList(name: string, description: string | undefined, createdBy: number): Promise<"created" | "exists">;

    deleteList(name: string): Promise<boolean>;

    //undefined — такого списка нет.
    includeChats(name: string, chatIds: readonly number[], addedBy: number): Promise<MembershipChange | undefined>;

    excludeChats(name: string, chatIds: readonly number[]): Promise<MembershipChange | undefined>;

    listsOverview(): Promise<ListsOverview>;

    listMembers(name: string): Promise<ListMember[] | undefined>;
}

//Отправка одному чату глазами рассыльщика. Как Telegram отвечает отказом и что из этого «насовсем»,
//знает адаптер (TelegramBroadcastSender), а не домен.
export interface BroadcastDelivery {
    deliver(chatId: number, content: BroadcastContent): Promise<DeliveryOutcome>;
}
