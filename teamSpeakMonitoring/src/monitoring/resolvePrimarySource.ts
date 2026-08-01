import type {ServerQuerySource} from "./MonitoredServer.js";

//Кто из источников сервера определяет online/offline.
//
//Правило: явно назначенный primary; если включённого primary нет — самый приоритетный из тех,
//что есть. Fallback существует ради отключения источников: выключили главный — не должно
//требоваться руками переназначать роль другому. Частный случай «остался один источник» покрыт
//тем же правилом, включая случай, когда единственный оставшийся помечен помощником.
//
//Чистая функция и без логгера намеренно: о том, что сработал fallback, предупреждает вызывающий,
//сравнив role выбранного источника с "primary". Иначе предупреждение печаталось бы из места,
//которое про логи знать не должно.
//
//sources должны приходить уже отфильтрованными по enabled и отсортированными по приоритету.
//Пустой список — не ошибка, а сервер, у которого все источники отключены: вызывающий его пропустит.
export function resolvePrimarySource(
    sources: readonly ServerQuerySource[],
    serverId: number,
): ServerQuerySource | undefined {
    const explicit = sources.filter(source => source.role === "primary");

    //Двух главных быть не может: статус определяется чьим-то одним ответом, и молча выбрать
    //«какого-нибудь» значит сделать поведение зависящим от порядка строк в выдаче БД.
    //Это порча данных, и ведём себя как parseQueryConfig при расхождении query_type.
    if (explicit.length > 1) {
        throw new Error(
            `Server ${serverId} has ${explicit.length} enabled primary query sources, expected one`,
        );
    }

    return explicit[0] ?? sources[0];
}
