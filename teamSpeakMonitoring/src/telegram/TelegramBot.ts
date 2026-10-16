import {Composer, type Bot, type BotError, type Context, type MiddlewareFn} from "grammy";
import type {BotCommand} from "grammy/types";
import type {Logger} from "pino";
import {DEFAULT_PERMISSIONS, type Permission} from "../access/Roles.js";
import {commandPermission} from "./commandAccess.js";
import {TelegramSender} from "./TelegramSender.js";
import {createApiLogger, createUpdateDeadline, createUpdateLogger, PollingWatchdog} from "./TelegramDiagnostics.js";

//Набор команд: знает, как повесить свои обработчики на бота и как назвать себя в меню.
//Зависимости у каждого набора свои — командам TeamSpeak нужно соединение, командам подписок
//репозитории, — и сваливать их в один конструктор незачем.
//
//Форма та же, что у уведомлений: NotificationDispatcher владеет доставкой, а список подписок
//собирается в composition root. Здесь ровно так же — владелец один, список снаружи.
//
//Регистрирует набор не на самом боте, а на Composer'е, перед которым стоит страж прав:
//внутрь попадает только то, что проверку прошло, и забыть проверку в отдельной команде нельзя.
export interface BotCommands {
    register(bot: Composer<Context>): void;

    //Подсказки, которые Telegram показывает при вводе «/». Метод обязательный, а не опциональный,
    //намеренно: новый набор не сможет молча не попасть в меню — компилятор потребует ответ.
    describe(): BotCommand[];
}

//Единственный владелец всего телеграмного: сам Bot, наборы команд, отправка и жизненный цикл.
//
//ВХОДЯЩЕЕ И ИСХОДЯЩЕЕ ЖИВУТ ПО РАЗНЫМ ПРАВИЛАМ, и это главное, что стоит знать про этот класс:
//
//  входящее (команды, кнопки) работает ТОЛЬКО после start(): start — это запуск long polling,
//    то есть цикла getUpdates. Без него обработчики зарегистрированы, но апдейты никто не забирает,
//    и бот просто молчит в ответ на команды;
//  исходящее (sender) работает ВСЕГДА: sendMessage — обычный HTTP-запрос к Bot API,
//    long polling ему не нужен. Уведомления уходят и до start(), и после stop().
//
//Раньше это было неочевидно, потому что TelegramSender создавался в main отдельно от бота
//и выглядел независимой сущностью. Он и есть независимая — но принадлежит тому же боту,
//поэтому живёт здесь.
export class TelegramBot {
    //Исходящая сторона. Публичная, потому что её адресует не бот, а уведомления: кому слать —
    //решают подписки, и знать об этом боту незачем.
    public readonly sender: TelegramSender;

    //Как часто спрашивать watchdog. Порог «стоит» у него 90 с, проверка раз в 15 с — погрешность мала.
    private static readonly WATCHDOG_CHECK_MS = 15_000;

    //Собирается из наборов, а не пишется отдельным списком: иначе добавленную команду легко
    //зарегистрировать и забыть показать. Это ПОЛНОЕ меню; каждый чат видит из него то,
    //на что у него есть права (menuFor).
    private readonly menu: BotCommand[];

    //Следит, ходит ли бот за апдейтами. Проверку дёргает таймер, живущий между start() и stop().
    private readonly watchdog: PollingWatchdog;
    private watchdogTimer: NodeJS.Timeout | undefined;

    //Bot создаётся в composition root: один long polling и один api-клиент на процесс.
    constructor(
        private readonly bot: Bot,
        commands: readonly BotCommands[],
        //Страж прав (AccessGuard). Обязательный параметр, а не «можно поставить потом»:
        //бот без стража не должен собираться вовсе.
        guard: MiddlewareFn<Context>,
        private readonly logger: Logger,
        //Потолок на обработку одного апдейта, TELEGRAM_UPDATE_TIMEOUT_MS. См. createUpdateDeadline.
        updateTimeoutMs: number,
    ) {
        this.sender = new TelegramSender(bot);
        this.menu = commands.flatMap(set => set.describe());
        this.watchdog = new PollingWatchdog(logger);

        //Диагностика ставится первой: трансформер видит каждый вызов Bot API, middleware —
        //каждый апдейт до любого набора команд, поэтому замер включает всю обработку.
        //Зачем она вообще — см. TelegramDiagnostics.
        bot.api.config.use(createApiLogger(logger, this.watchdog));
        bot.use(createUpdateLogger(logger, this.watchdog));
        //Следом — дедлайн: grammy не зовёт следующий getUpdates, пока не отработал обработчик,
        //и один повисший обработчик делал бота глухим до перезапуска контейнера.
        bot.use(createUpdateDeadline(logger, updateTimeoutMs));

        //Превью ссылок выключается один раз на весь исходящий трафик, а не в каждом вызове reply.
        //Названия серверов почти всегда содержат приглашение в discord, и Telegram рисует под
        //каждым сообщением карточку чужого сообщества: список серверов превращается в ленту
        //рекламных блоков, а уведомление о входе игрока занимает пол-экрана.
        //
        //Трансформер, а не параметр у каждого вызова: мест отправки уже полтора десятка
        //(нотифаеры, ответы команд, правки сообщений), и забытый параметр в новом месте
        //никак бы себя не проявил до появления ссылки в тексте.
        //
        //payload идёт ПОСЛЕ умолчания: вызов, которому превью нужно, сможет его включить.
        bot.api.config.use((prev, method, payload, signal) => {
            if (method !== "sendMessage" && method !== "editMessageText") {
                return prev(method, payload, signal);
            }

            return prev(method, {link_preview_options: {is_disabled: true}, ...payload}, signal);
        });

        //Все наборы — за одним стражем. Один, а не по стражу на набор: middleware, не вызвавший
        //next(), останавливает апдейт целиком, и страж первого набора перекрыл бы все следующие.
        const guarded = new Composer<Context>();

        guarded.use(guard);

        for (const set of commands) {
            set.register(guarded);
        }

        bot.use(guarded);

        //Обязателен, а не «на всякий случай». Без него ЛЮБАЯ ошибка внутри обработчика для grammy
        //фатальна: она гасит long polling («Stopping bot»), после чего падает и сам getUpdates.
        //Снаружи это выглядит как «мониторинг работает, а бот молча умер до перезапуска процесса» —
        //поймано на отладке T4a, когда моргнула сеть и sendMessage не прошёл.
        //
        //Одинаково в деве и в проде: разное поведение окружений означает, что отлаживаешь одно,
        //а работает другое. Точка останова для отладчика — здесь же: сюда приходит и ошибка,
        //и контекст апдейта, на котором она случилась.
        bot.catch((error: BotError) => {
            this.logger.error(
                {error: error.error, updateId: error.ctx.update.update_id, chatId: error.ctx.chatId},
                "Ошибка при обработке апдейта Telegram",
            );
        });
    }

    //start() возвращает промис, который разрешится только при остановке бота, поэтому его нельзя
    //ждать — иначе запуск приложения из него не вернётся. Но и голый void оставлять нельзя:
    //отказ самого long polling ушёл бы в unhandled rejection и не попал бы в лог вообще.
    public start(): void {
        //Меню публикуется здесь, а не в конструкторе: это сетевой вызов, а конструктор должен
        //оставаться дешёвым и безотказным. Отказ не мешает работе — команды продолжат отвечать,
        //просто подсказок при вводе «/» не будет, — поэтому только лог.
        //Область по умолчанию — запасной вариант для любого чата, а узкие (конкретный чат) её только
        //переопределяют. В неё уходит меню роли по умолчанию: её получает каждый чат при /start,
        //поэтому персональное меню нужно лишь тем, чьи права от неё отличаются (publishChatMenu).
        //Незнакомец до /start тоже видит серверные команды — и в ответ на них получает «нажмите
        ///start»; публиковать меню каждому чату ради этого незачем.
        void this.bot.api.setMyCommands(this.menuFor(DEFAULT_PERMISSIONS)).catch((error: unknown) => {
            this.logger.error({error}, "Не удалось опубликовать меню команд Telegram");
        });

        this.watchdog.started(Date.now());
        //unref: таймер наблюдения не должен держать процесс живым при остановке.
        this.watchdogTimer = setInterval(() => this.watchdog.check(Date.now()), TelegramBot.WATCHDOG_CHECK_MS);
        this.watchdogTimer.unref();

        void this.bot.start({
            onStart: botInfo => this.logger.info({username: botInfo.username}, "Long polling Telegram запущен"),
        }).then(() => {
            this.logger.info("Long polling Telegram остановлен");
        }, (error: unknown) => {
            this.logger.error({error}, "Long polling Telegram остановлен ошибкой — бот не принимает команды");
        });
    }

    public async stop(): Promise<void> {
        clearInterval(this.watchdogTimer);
        this.watchdogTimer = undefined;
        await this.bot.stop();
    }

    //Полное меню всех наборов. Публично только ради теста: собранное меню — единственное, чего
    //не видно снаружи иначе как сетевым вызовом.
    public describeMenu(): readonly BotCommand[] {
        return this.menu;
    }

    //Что из меню доступно при этих правах. Команда, которой нет в карте прав, не показывается
    //никому — ровно как страж её никому не пропустит.
    public menuFor(permissions: ReadonlySet<Permission>): BotCommand[] {
        return this.menu.filter(item => {
            const required = commandPermission(item.command);

            return required !== undefined && permissions.has(required);
        });
    }

    //Персональное меню чата. Права совпали с умолчанием — персональное снимается, и чат видит
    //общее: так после отзыва не остаётся меню с командами, которых больше нет.
    public async publishChatMenu(chatId: number, permissions: ReadonlySet<Permission>): Promise<void> {
        const scope = {type: "chat", chat_id: chatId} as const;

        if (sameSet(permissions, DEFAULT_PERMISSIONS)) {
            await this.bot.api.deleteMyCommands({scope});
            return;
        }

        await this.bot.api.setMyCommands(this.menuFor(permissions), {scope});
    }
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
    return left.size === right.size && [...left].every(item => right.has(item));
}
