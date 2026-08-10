import type {PlayerSample} from "./PlayerHistory.js";

//Правило «похоже, раунд заканчивается». Чистая функция: окно замеров и текущее значение на входе,
//вердикт на выходе. Ни времени, ни хранилища, ни событий — поэтому проверяется целиком тестами.
//
//Проверено на двух сутках прод-логов (telegram.md, §11): 21 конец раунда из 22 предсказан,
//ложных срабатываний нет, запас до перезапуска 79…106 секунд, медиана 100.
//
//Почему именно спад, а не уход в offline: три перезапуска из 22 прошли без offline вообще —
//A2S продолжал отвечать, счётчик просто обнулялся. По offline их не увидеть.

export interface RoundFinishRule {
    //Насколько должно упасть от базы, доля: 0.25 — на четверть.
    drop: number;
    //Минимальная база, ниже которой не сигналим: спад 4 → 1 это не конец раунда.
    minBase: number;
}

//База — максимум за окно, а не среднее: раунд заканчивается с плато, и именно от плато
//считается спад. Среднее размазало бы начало спада по окну и сработало бы позже.
export function detectRoundFinish(
    window: readonly PlayerSample[],
    players: number,
    rule: RoundFinishRule,
): boolean {
    if (window.length === 0) {
        return false;
    }

    const base = Math.max(...window.map(sample => sample.players));

    if (base < rule.minBase) {
        return false;
    }

    return players <= base * (1 - rule.drop);
}

//Эпизод закончился — можно сигналить снова. Отдельно от срабатывания, потому что это другой
//вопрос: «пора ли говорить» и «пора ли снова слушать» не совпадают по времени.
//Возврат к базе, а не «прошло N минут»: после перезапуска сервер наполняется постепенно,
//и таймер сработал бы посреди наполнения.
export function isEpisodeOver(
    window: readonly PlayerSample[],
    players: number,
    recovery = 0.9,
): boolean {
    if (window.length === 0) {
        return true;
    }

    return players >= Math.max(...window.map(sample => sample.players)) * recovery;
}
