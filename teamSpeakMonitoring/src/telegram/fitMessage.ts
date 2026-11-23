//Telegram режет сообщение на 4096 символах и отказывается отправить длиннее — сообщение не уходит
//вовсе. Запас — под хвост «…и ещё N строк». Резать можно только по границе строки: разметка HTML
//в списках бота закрывается в пределах своей строки, а разрезанный тег Telegram тоже отвергнет.
export const MESSAGE_BUDGET = 3_800;

export function fitMessage(lines: readonly string[], budget: number = MESSAGE_BUDGET): string {
    const kept: string[] = [];
    let length = 0;

    for (const [index, line] of lines.entries()) {
        if (length + line.length + 1 > budget) {
            kept.push(`…и ещё ${lines.length - index} строк — не влезло в сообщение`);
            break;
        }

        kept.push(line);
        length += line.length + 1;
    }

    return kept.join("\n");
}
