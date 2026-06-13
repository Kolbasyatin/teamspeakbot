export type ScheduledTaskId = number | string;

export interface ScheduledTask {
    readonly id: ScheduledTaskId;

    run(): Promise<void>;

    getNextDelayMs(): number;
}

export class Scheduler<TTask extends ScheduledTask> {
    private readonly tasks = new Map<ScheduledTaskId, TTask>();
    private readonly timers = new Map<ScheduledTaskId, NodeJS.Timeout>();
    private running = false;

    public sync(tasks: Iterable<TTask>): void {
        const nextTasks = new Map<ScheduledTaskId, TTask>();

        for (const task of tasks) {
            nextTasks.set(task.id, task);
        }

        //Удаляем уже не существующие, не трогая текущие (нужно чтоб не нарушить текущие таймеры)
        for (const taskId of this.tasks.keys()) {
            if (nextTasks.has(taskId)) {
                continue;
            }

            this.cancel(taskId);
            this.tasks.delete(taskId);
        }

        for (const [taskId, task] of nextTasks) {
            const isNewTask = !this.tasks.has(taskId);

            this.tasks.set(taskId, task);

            if (this.running && isNewTask) {
                this.schedule(taskId, 0);
            }
        }
    }

    public start(): void {
        if (this.running) {
            return;
        }

        this.running = true;

        for (const taskId of this.tasks.keys()) {
            this.schedule(taskId, 0);
        }
    }

    public stop(): void {
        this.running = false;

        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }

        this.timers.clear();
    }

    private schedule(taskId: ScheduledTaskId, delayMs: number): void {
        this.cancel(taskId);

        const timer = setTimeout(() => {
            void this.runTask(taskId);
        }, delayMs);

        this.timers.set(taskId, timer);
    }

    private async runTask(taskId: ScheduledTaskId): Promise<void> {
        this.timers.delete(taskId);
        if (!this.running) {
            return;
        }
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }
        await task.run();
        if (!this.running) {
            return;
        }
        this.schedule(taskId, task.getNextDelayMs());
    }

    private cancel(taskId: ScheduledTaskId): void {
        const timer = this.timers.get(taskId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        this.timers.delete(taskId);
    }
}