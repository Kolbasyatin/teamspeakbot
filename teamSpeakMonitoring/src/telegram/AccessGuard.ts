import type {Context, MiddlewareFn} from "grammy";
import type {Logger} from "pino";
import type {Permission} from "../access/Roles.js";
import {callbackPermission, commandPermission} from "./commandAccess.js";

//Стражу нужен один вопрос — «можно ли этому чату вот это». Весь AccessControl ему знать незачем.
export interface AccessChecker {
    can(chatId: number, permission: Permission): Promise<boolean>;
}

export const DENIED_TEXT = [
    "⛔ Эта команда вам недоступна.",
    "",
    "Впервые здесь — нажмите /start. Нужен доступ — пришлите администратору свой id из /whoami.",
].join("\n");

const DENIED_BUTTON_TEXT = "⛔ Недоступно";
const OUTDATED_BUTTON_TEXT = "Кнопка устарела, открой список заново";

//Что за апдейт, глазами прав. Разбор — чистая функция, чтобы проверять её без grammy.
export type GuardedUpdate =
    | {kind: "command"; command: string}
    | {kind: "callback"; data: string}
    //Апдейт не для нас: команда другому боту в группе, обычный текст, правка сообщения, вступление
    //в чат и всё прочее, на что у бота нет обработчиков.
    | {kind: "other"};

//Команда — так же, как её узнаёт grammy: сущность bot_command в самом начале текста.
//«/watch@OtherBot» в группе адресована другому боту, и это не наш апдейт.
export function classifyUpdate(ctx: Context): GuardedUpdate {
    const data = ctx.callbackQuery?.data;

    if (data !== undefined) {
        return {kind: "callback", data};
    }

    //Только новые сообщения и посты канала — ровно там grammy ищет команды. Правка сообщения
    //с командой обработчиков не вызывает, значит и разрешать в ней нечего.
    const message = ctx.message ?? ctx.channelPost;
    const text = message?.text ?? message?.caption;
    const entities = message?.entities ?? message?.caption_entities ?? [];
    const command = entities.find(entity => entity.type === "bot_command" && entity.offset === 0);

    if (text === undefined || command === undefined) {
        return {kind: "other"};
    }

    const [name = "", target] = text.slice(1, command.length).split("@");

    if (target !== undefined && target.toLowerCase() !== ctx.me?.username?.toLowerCase()) {
        return {kind: "other"};
    }

    return {kind: "command", command: name};
}

//Единственная точка проверки прав для всего входящего. Ставится ПЕРЕД всеми наборами команд
//одним экземпляром: в grammy middleware, не вызвавший next(), останавливает апдейт целиком,
//поэтому страж на каждом наборе отдельно перекрыл бы команды всех следующих.
//
//Fail closed по всем осям: дальше проходит только то, что есть в карте и разрешено. Команда,
//которой нет в карте, кнопка с незнакомыми данными, любой другой апдейт — не проходят.
//Поэтому новый обработчик, забытый в карте, не работает вовсе, а не работает открытым.
export function createAccessGuard(access: AccessChecker, logger: Logger): MiddlewareFn<Context> {
    return async (ctx, next) => {
        const update = classifyUpdate(ctx);

        if (update.kind === "other") {
            return;
        }

        const chatId = ctx.chatId;

        if (update.kind === "command") {
            const required = commandPermission(update.command);

            //Незнакомая команда — молчим, как молчал бот и раньше: в группе отвечать на каждую
            //чужую или ошибочную команду значит засорять чат.
            if (required === undefined || chatId === undefined) {
                return;
            }

            if (!await access.can(chatId, required)) {
                logger.info({chatId, command: update.command, required}, "Команда отклонена: нет прав");
                await ctx.reply(DENIED_TEXT);
                return;
            }

            await next();
            return;
        }

        const required = callbackPermission(update.data);

        //Кнопку надо подтвердить в любом случае: без answerCallbackQuery Telegram держит
        //индикатор загрузки около тридцати секунд, и это выглядит как зависший бот.
        if (required === undefined || chatId === undefined) {
            await ctx.answerCallbackQuery(OUTDATED_BUTTON_TEXT);
            return;
        }

        if (!await access.can(chatId, required)) {
            logger.info({chatId, data: update.data, required}, "Кнопка отклонена: нет прав");
            await ctx.answerCallbackQuery(DENIED_BUTTON_TEXT);
            return;
        }

        await next();
    };
}
