import type {Logger} from "pino";
import {
    DEFAULT_ROLE,
    isRole,
    manageRefusal,
    permissionsOfRoles,
    type ManageRefusal,
    type Permission,
    type Role,
} from "./Roles.js";

//Одно назначение роли, как оно лежит в базе.
export interface RoleAssignment {
    chatId: number;
    role: string;
    grantedBy: number | undefined;
    grantedAt: Date;
    note: string | undefined;
    //Название чата — человеку, читающему /roles; логика на него не завязана.
    chatTitle: string | undefined;
}

export type StoredGrantResult = "granted" | "alreadyGranted" | "unknownChat";

//Хранилище назначений глазами доступа. Объявлено здесь, у потребителя, как Querier в monitoring/.
export interface RoleStore {
    //Строки как есть: роль, которой в коде больше нет, отсеивает потребитель.
    findRoles(chatId: number): Promise<string[]>;

    findAssignments(): Promise<RoleAssignment[]>;

    //Назначения одного чата — со строками, которых в коде уже нет: администратору надо видеть
    //и мёртвые назначения, иначе непонятно, почему «роль выдана, а не работает».
    findAssignmentsByChat(chatId: number): Promise<RoleAssignment[]>;

    grant(chatId: number, role: Role, grantedBy: number | undefined, note: string | undefined): Promise<StoredGrantResult>;

    //true — назначение было и удалено.
    revoke(chatId: number, role: Role): Promise<boolean>;

    //Роль по умолчанию — ОДИН раз за всю историю чата. true — выдана сейчас.
    grantDefaultOnce(chatId: number, role: Role): Promise<boolean>;
}

//Кто раздаёт права: человек, а не чат, где набрана команда (см. accessSubject в commandAccess.ts).
//Его личные права — права его лички с ботом: user_id равен её chat_id. Он же пишется в granted_by.
export interface AccessActor {
    userId: number;
}

export type AccessChange =
    | {result: "granted" | "revoked"}
    | {result: "alreadyGranted" | "notGranted" | "unknownChat"}
    | {result: "refused"; reason: ManageRefusal};

//Что делать, когда чат потерял права. Решает composition root: подписки на серверы и на игроков
//живут в разных репозиториях, и доступу про них знать незачем.
export type PermissionsLostHandler = (chatId: number, lost: ReadonlySet<Permission>) => Promise<void>;

//Единственное место, которое отвечает на вопрос «что можно этому чату», и единственное,
//через которое права меняются. Страж, команды администратора и меню спрашивают здесь.
export class AccessControl {
    //Роли из базы по чату. Проверка идёт на каждый апдейт, а меняются роли редко — поэтому кэш,
    //который сбрасывается при любой выдаче и отзыве. Процесс один, второго писателя нет.
    private readonly cache = new Map<number, readonly Role[]>();

    public constructor(
        private readonly store: RoleStore,
        //TELEGRAM_ROOT_CHAT_IDS. Root берётся из конфига, а не из базы: иначе неудачным /revoke
        //можно запереть себя навсегда, и чинить пришлось бы руками в MariaDB.
        private readonly rootChatIds: ReadonlySet<number>,
        private readonly onPermissionsLost: PermissionsLostHandler,
        private readonly logger: Logger,
    ) {
    }

    public isRoot(chatId: number): boolean {
        return this.rootChatIds.has(chatId);
    }

    public listRootChatIds(): readonly number[] {
        return [...this.rootChatIds];
    }

    //Роли чата: назначенные в базе плюс ROLE_ROOT из конфига.
    public async rolesOf(chatId: number): Promise<readonly Role[]> {
        const stored = await this.storedRolesOf(chatId);

        return this.isRoot(chatId) ? ["ROLE_ROOT", ...stored] : stored;
    }

    public async permissionsOf(chatId: number): Promise<ReadonlySet<Permission>> {
        return permissionsOfRoles(await this.rolesOf(chatId));
    }

    public async can(chatId: number, permission: Permission): Promise<boolean> {
        return (await this.permissionsOf(chatId)).has(permission);
    }

    public listAssignments(): Promise<RoleAssignment[]> {
        return this.store.findAssignments();
    }

    public listAssignmentsOf(chatId: number): Promise<RoleAssignment[]> {
        return this.store.findAssignmentsByChat(chatId);
    }

    public async grant(actor: AccessActor, targetChatId: number, role: Role, note: string | undefined): Promise<AccessChange> {
        const refusal = await this.refusalFor(actor, role);

        if (refusal) {
            return {result: "refused", reason: refusal};
        }

        const result = await this.store.grant(targetChatId, role, actor.userId, note);

        this.cache.delete(targetChatId);
        this.logger.info({actor, targetChatId, role, result}, "Выдача роли");

        return {result};
    }

    public async revoke(actor: AccessActor, targetChatId: number, role: Role): Promise<AccessChange> {
        const refusal = await this.refusalFor(actor, role);

        if (refusal) {
            return {result: "refused", reason: refusal};
        }

        const before = await this.permissionsOf(targetChatId);
        const removed = await this.store.revoke(targetChatId, role);

        this.cache.delete(targetChatId);
        this.logger.info({actor, targetChatId, role, removed}, "Отзыв роли");

        if (!removed) {
            return {result: "notGranted"};
        }

        //Потерянное считается по итогу, а не по составу отозванной роли: право могло остаться
        //от другой роли того же чата, и тогда отбирать нечего.
        const after = await this.permissionsOf(targetChatId);
        const lost = new Set([...before].filter(permission => !after.has(permission)));

        if (lost.size > 0) {
            await this.onPermissionsLost(targetChatId, lost);
        }

        return {result: "revoked"};
    }

    //Роль по умолчанию при /start. Однократно за всю историю чата: иначе тот, у кого роль отобрали,
    //вернул бы её себе повторным /start, и отзыв перестал бы работать.
    public async grantDefaultOnce(chatId: number): Promise<boolean> {
        const granted = await this.store.grantDefaultOnce(chatId, DEFAULT_ROLE);

        if (granted) {
            this.cache.delete(chatId);
            this.logger.info({chatId, role: DEFAULT_ROLE}, "Выдана роль по умолчанию");
        }

        return granted;
    }

    private async refusalFor(actor: AccessActor, role: Role): Promise<ManageRefusal | undefined> {
        return manageRefusal(await this.permissionsOf(actor.userId), this.isRoot(actor.userId), role);
    }

    private async storedRolesOf(chatId: number): Promise<readonly Role[]> {
        const cached = this.cache.get(chatId);

        if (cached) {
            return cached;
        }

        const raw = await this.store.findRoles(chatId);
        const roles = raw.filter(isRole);

        //Роль переименовали или удалили в коде, а назначение в базе осталось. Не доступ,
        //но и не повод падать: строка лежит мёртвой, пока её не уберут.
        if (roles.length !== raw.length) {
            this.logger.warn(
                {chatId, unknown: raw.filter(role => !isRole(role))},
                "В базе назначены роли, которых нет в коде, — они игнорируются",
            );
        }

        this.cache.set(chatId, roles);

        return roles;
    }
}
