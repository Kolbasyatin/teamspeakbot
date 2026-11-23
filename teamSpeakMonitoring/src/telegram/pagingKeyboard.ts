import {InlineKeyboard} from "grammy";

//Кнопки «◀ ▶» для постраничных списков (/chats, история чата, /feedback). Одна страница — кнопок нет.
//Код кнопки задаёт вызывающий: у каждого списка своё пространство callback_data и своё право.
export function pagingKeyboard(page: number, pages: number, encode: (page: number) => string): InlineKeyboard | undefined {
    if (pages <= 1) {
        return undefined;
    }

    const keyboard = new InlineKeyboard();

    if (page > 0) {
        keyboard.text("◀", encode(page - 1));
    }

    if (page < pages - 1) {
        keyboard.text("▶", encode(page + 1));
    }

    return keyboard;
}
