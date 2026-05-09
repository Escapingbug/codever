/**
 * Scheduler — Timer-based task scheduling for codever sessions.
 *
 * Design decisions:
 * - Supports both one-shot and recurring tasks.
 * - Persisted to config — survives codever restart.
 * - Triggers via onTrigger callback (typically QueryLoop.processInput()).
 * - One-shot tasks are automatically deleted after firing.
 * - Recurring tasks re-register themselves after each firing.
 */

import { randomUUID } from 'node:crypto'

export interface ScheduledTask {
    id: string
    /** The topic key identifying which session/bridge topic this task belongs to */
    topicKey: string
    triggerAt: number
    message: string
    context?: string
    /** If set, re-schedule with this interval after firing (in ms) */
    recurringMs?: number
}

export interface SchedulerConfig {
    onTrigger: (task: ScheduledTask) => void
}

export class Scheduler {
    private tasks = new Map<string, { task: ScheduledTask; timer: ReturnType<typeof setTimeout> }>()
    private onTrigger: (task: ScheduledTask) => void

    constructor(config: SchedulerConfig) {
        this.onTrigger = config.onTrigger
    }

    /**
     * Schedule a task. One-shot by default; set recurringMs for repeating.
     */
    schedule(input: Omit<ScheduledTask, 'id'>): ScheduledTask {
        const task: ScheduledTask = {
            id: randomUUID(),
            ...input,
        }

        const delay = Math.max(0, task.triggerAt - Date.now())

        const timer = setTimeout(() => {
            this.triggerTask(task.id)
        }, delay)

        this.tasks.set(task.id, { task, timer })
        return task
    }

    /**
     * Cancel a scheduled task.
     */
    cancel(taskId: string): boolean {
        const entry = this.tasks.get(taskId)
        if (!entry) return false

        clearTimeout(entry.timer)
        this.tasks.delete(taskId)
        return true
    }

    /**
     * Get a specific task by id.
     */
    getTask(taskId: string): ScheduledTask | undefined {
        return this.tasks.get(taskId)?.task
    }

    /**
     * List all pending (not yet triggered) tasks.
     */
    listPending(): ScheduledTask[] {
        return Array.from(this.tasks.values()).map(entry => entry.task)
    }

    /**
     * Cancel all scheduled tasks.
     */
    stopAll(): void {
        for (const entry of this.tasks.values()) {
            clearTimeout(entry.timer)
        }
        this.tasks.clear()
    }

    /**
     * Save all tasks to a serializable format for persistence.
     */
    saveTasks(): ScheduledTask[] {
        return Array.from(this.tasks.values()).map(entry => ({ ...entry.task }))
    }

    /**
     * Load tasks from persisted data. Past-due tasks are triggered immediately.
     */
    loadTasks(saved: ScheduledTask[]): void {
        for (const task of saved) {
            const delay = Math.max(0, task.triggerAt - Date.now())

            const timer = setTimeout(() => {
                this.triggerTask(task.id)
            }, delay)

            this.tasks.set(task.id, { task, timer })
        }
    }

    private triggerTask(taskId: string): void {
        const entry = this.tasks.get(taskId)
        if (!entry) return

        const task = entry.task
        this.tasks.delete(taskId)
        this.onTrigger(task)

        // Re-schedule if recurring
        if (task.recurringMs) {
            this.schedule({
                topicKey: task.topicKey,
                triggerAt: Date.now() + task.recurringMs,
                message: task.message,
                context: task.context,
                recurringMs: task.recurringMs,
            })
        }
    }
}
