import {createHash} from "node:crypto";
import {readdir, readFile} from "node:fs/promises";

//Одна миграция: номер версии, человекочитаемое имя, SQL и его отпечаток.
//Отпечаток нужен, чтобы поймать правку УЖЕ применённой миграции — иначе прод и дев разойдутся
//молча: у обоих в schema_migrations стоит одна и та же версия, а схема разная.
export interface MigrationFile {
    version: number;
    name: string;
    sql: string;
    checksum: string;
}

//Имя файла — часть контракта: NNN_описание.sql, номер задаёт порядок применения.
const FILE_NAME_PATTERN = /^(\d+)_([a-z0-9_]+)\.sql$/;

//Разбор имени вынесен отдельно от чтения диска, чтобы проверяться без файловой системы.
export function parseMigrationFileName(fileName: string): {version: number; name: string} {
    const match = FILE_NAME_PATTERN.exec(fileName);

    if (!match?.[1] || !match[2]) {
        throw new Error(
            `Migration file name must look like 001_description.sql, got: ${fileName}`,
        );
    }

    return {version: Number(match[1]), name: match[2]};
}

export function checksumOf(sql: string): string {
    return createHash("sha256").update(sql).digest("hex");
}

//Читает каталог миграций и отдаёт их в порядке версий.
//Чужие файлы не игнорируются, а роняют команду: молча пропущенная миграция хуже отказа.
export async function readMigrationFiles(directory: URL): Promise<MigrationFile[]> {
    const fileNames = await readdir(directory);
    const files: MigrationFile[] = [];

    for (const fileName of fileNames.toSorted()) {
        const {version, name} = parseMigrationFileName(fileName);
        const sql = await readFile(new URL(fileName, directory), "utf8");

        files.push({version, name, sql, checksum: checksumOf(sql)});
    }

    files.sort((left, right) => left.version - right.version);

    const duplicate = files.find((file, index) => files[index + 1]?.version === file.version);

    if (duplicate) {
        throw new Error(`Duplicate migration version: ${duplicate.version}`);
    }

    return files;
}
