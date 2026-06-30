import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Scheduler, type ScheduledTask } from '@/core/scheduler'

describe('Scheduler', () => {
    let scheduler: Scheduler
    let triggeredTasks: { taskId: string; message: string; topicKey: string }[]

    beforeEach(() => {
        vi.useFakeTimers()
        triggeredTasks = []
        scheduler = new Scheduler({
            onTrigger: (task) => {
                triggeredTasks.push({ taskId: task.id, message: task.message, topicKey: task.topicKey })
            },
        })
    })

    afterEach(() => {
        scheduler.stopAll()
        vi.useRealTimers()
    })

    describe('schedule', () => {
        it('creates a one-shot task with auto-generated id', () => {
            const task = scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Check on progress',
            })

            expect(task.id).toBeDefined()
            expect(task.id.length).toBeGreaterThan(0)
            expect(task.topicKey).toBe('12345:main')
            expect(task.message).toBe('Check on progress')
        })

        it('triggers task at the scheduled time', () => {
            const triggerAt = Date.now() + 5000
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt,
                message: 'Reminder',
            })

            vi.advanceTimersByTime(4999)
            expect(triggeredTasks.length).toBe(0)

            vi.advanceTimersByTime(1)
            expect(triggeredTasks.length).toBe(1)
            expect(triggeredTasks[0].message).toBe('Reminder')
        })

        it('deletes task after triggering (one-shot)', () => {
            const triggerAt = Date.now() + 5000
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt,
                message: 'Reminder',
            })

            vi.advanceTimersByTime(5000)
            expect(triggeredTasks.length).toBe(1)

            // Advance more — should not trigger again
            vi.advanceTimersByTime(10000)
            expect(triggeredTasks.length).toBe(1)
        })

        it('can schedule multiple tasks', () => {
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 1000,
                message: 'First',
            })
            scheduler.schedule({
                topicKey: '67890:42',
                triggerAt: Date.now() + 3000,
                message: 'Second',
            })

            vi.advanceTimersByTime(1000)
            expect(triggeredTasks.length).toBe(1)
            expect(triggeredTasks[0].message).toBe('First')

            vi.advanceTimersByTime(2000)
            expect(triggeredTasks.length).toBe(2)
            expect(triggeredTasks[1].message).toBe('Second')
        })

        it('triggers past-due tasks immediately', () => {
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() - 1000, // 1 second in the past
                message: 'Overdue',
            })

            // Should trigger on next tick
            vi.advanceTimersByTime(0)
            expect(triggeredTasks.length).toBe(1)
        })
    })

    describe('cancel', () => {
        it('cancels a scheduled task', () => {
            const task = scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Cancel me',
            })

            scheduler.cancel(task.id)

            vi.advanceTimersByTime(10000)
            expect(triggeredTasks.length).toBe(0)
        })

        it('cancel is no-op for unknown taskId', () => {
            expect(scheduler.cancel('nonexistent')).toBe(false)
        })

        it('cancel returns true for existing task', () => {
            const task = scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Cancel me',
            })

            expect(scheduler.cancel(task.id)).toBe(true)
        })

        it('cancels tasks matching a predicate', () => {
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Cancel me',
            })
            scheduler.schedule({
                topicKey: '67890:42',
                triggerAt: Date.now() + 5000,
                message: 'Keep me',
            })

            const cancelled = scheduler.cancelWhere(task => task.topicKey === '12345:main')

            expect(cancelled.map(task => task.message)).toEqual(['Cancel me'])
            vi.advanceTimersByTime(5000)
            expect(triggeredTasks.map(task => task.message)).toEqual(['Keep me'])
        })
    })

    describe('list', () => {
        it('returns all pending tasks', () => {
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Task 1',
            })
            scheduler.schedule({
                topicKey: '67890:42',
                triggerAt: Date.now() + 10000,
                message: 'Task 2',
            })

            const tasks = scheduler.listPending()
            expect(tasks.length).toBe(2)
        })

        it('does not include triggered (deleted) tasks', () => {
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 1000,
                message: 'Will trigger',
            })
            scheduler.schedule({
                topicKey: '67890:42',
                triggerAt: Date.now() + 20000,
                message: 'Will remain',
            })

            vi.advanceTimersByTime(1000)
            const tasks = scheduler.listPending()
            expect(tasks.length).toBe(1)
            expect(tasks[0].message).toBe('Will remain')
        })
    })

    describe('stopAll', () => {
        it('cancels all scheduled tasks', () => {
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Task 1',
            })
            scheduler.schedule({
                topicKey: '67890:42',
                triggerAt: Date.now() + 10000,
                message: 'Task 2',
            })

            scheduler.stopAll()

            vi.advanceTimersByTime(30000)
            expect(triggeredTasks.length).toBe(0)
        })
    })

    describe('getTask', () => {
        it('returns a specific task by id', () => {
            const task = scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Find me',
            })

            const found = scheduler.getTask(task.id)
            expect(found).toBeDefined()
            expect(found!.message).toBe('Find me')
        })

        it('returns undefined for unknown id', () => {
            expect(scheduler.getTask('nonexistent')).toBeUndefined()
        })
    })

    describe('persistence', () => {
        it('saveTasks returns serializable task data', () => {
            const task = scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: 1700000000000,
                message: 'Persist me',
                context: 'Test context',
            })

            const saved = scheduler.saveTasks()
            expect(saved.length).toBe(1)
            expect(saved[0].id).toBe(task.id)
            expect(saved[0].topicKey).toBe('12345:main')
            expect(saved[0].message).toBe('Persist me')
        })

        it('loadTasks restores tasks from saved data', () => {
            const task = scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Original',
            })

            const saved = scheduler.saveTasks()
            scheduler.stopAll()

            const newScheduler = new Scheduler({
                onTrigger: (t) => triggeredTasks.push({ taskId: t.id, message: t.message, topicKey: t.topicKey }),
            })
            newScheduler.loadTasks(saved)

            vi.advanceTimersByTime(5000)
            expect(triggeredTasks.length).toBe(1)
            expect(triggeredTasks[0].message).toBe('Original')
        })

        it('loadTasks skips tasks that are already past due (triggers them immediately)', () => {
            const saved: ScheduledTask[] = [{
                id: 'old-task',
                topicKey: '12345:main',
                triggerAt: Date.now() - 10000, // past due
                message: 'Old task',
            }]

            const newScheduler = new Scheduler({
                onTrigger: (t) => triggeredTasks.push({ taskId: t.id, message: t.message, topicKey: t.topicKey }),
            })
            newScheduler.loadTasks(saved)

            vi.advanceTimersByTime(0)
            expect(triggeredTasks.length).toBe(1)
        })

        it('notifies persistence after one-shot tasks are removed', () => {
            const changes: ScheduledTask[][] = []
            const persistentScheduler = new Scheduler({
                onTrigger: (t) => triggeredTasks.push({ taskId: t.id, message: t.message, topicKey: t.topicKey }),
                onTasksChanged: (tasks) => changes.push(tasks),
            })

            try {
                persistentScheduler.schedule({
                    topicKey: '12345:main',
                    triggerAt: Date.now() + 5000,
                    message: 'Persisted one-shot',
                })

                vi.advanceTimersByTime(5000)

                expect(triggeredTasks.length).toBe(1)
                expect(changes[changes.length - 1]).toEqual([])
            } finally {
                persistentScheduler.stopAll()
            }
        })

        it('notifies persistence after recurring tasks are re-scheduled', () => {
            const changes: ScheduledTask[][] = []
            const persistentScheduler = new Scheduler({
                onTrigger: (t) => triggeredTasks.push({ taskId: t.id, message: t.message, topicKey: t.topicKey }),
                onTasksChanged: (tasks) => changes.push(tasks),
            })

            try {
                const original = persistentScheduler.schedule({
                    topicKey: '12345:main',
                    triggerAt: Date.now() + 5000,
                    message: 'Persisted recurring',
                    recurringMs: 10000,
                })

                vi.advanceTimersByTime(5000)

                const latest = changes[changes.length - 1]
                expect(triggeredTasks.length).toBe(1)
                expect(latest.length).toBe(1)
                expect(latest[0].id).toBe(original.id)
                expect(latest[0].topicKey).toBe('12345:main')
                expect(latest[0].recurringMs).toBe(10000)
            } finally {
                persistentScheduler.stopAll()
            }
        })

        it('persists recurring task target updates made during trigger handling', () => {
            const changes: ScheduledTask[][] = []
            const persistentScheduler = new Scheduler({
                onTrigger: (task) => {
                    task.topicKey = '-100:10'
                    triggeredTasks.push({ taskId: task.id, message: task.message, topicKey: task.topicKey })
                },
                onTasksChanged: (tasks) => changes.push(tasks),
            })

            try {
                persistentScheduler.schedule({
                    topicKey: 'provider-session-1',
                    triggerAt: Date.now() + 5000,
                    message: 'Migrate recurring',
                    recurringMs: 10000,
                })

                vi.advanceTimersByTime(5000)

                const latest = changes[changes.length - 1]
                expect(triggeredTasks[0].topicKey).toBe('-100:10')
                expect(latest.length).toBe(1)
                expect(latest[0].topicKey).toBe('-100:10')
            } finally {
                persistentScheduler.stopAll()
            }
        })
    })

    describe('recurring', () => {
        it('re-schedules a recurring task after triggering', () => {
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Recurring reminder',
                recurringMs: 10000,
            })

            // First trigger
            vi.advanceTimersByTime(5000)
            expect(triggeredTasks.length).toBe(1)
            expect(triggeredTasks[0].message).toBe('Recurring reminder')

            // Second trigger after recurringMs
            vi.advanceTimersByTime(10000)
            expect(triggeredTasks.length).toBe(2)

            // Third trigger
            vi.advanceTimersByTime(10000)
            expect(triggeredTasks.length).toBe(3)
        })

        it('recurring task appears in pending list after each re-schedule', () => {
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Recurring',
                recurringMs: 10000,
            })

            expect(scheduler.listPending().length).toBe(1)

            vi.advanceTimersByTime(5000)
            expect(triggeredTasks.length).toBe(1)
            // New recurring task should be registered
            expect(scheduler.listPending().length).toBe(1)
        })

        it('can cancel a recurring task', () => {
            const task = scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Recurring',
                recurringMs: 10000,
            })

            scheduler.cancel(task.id)

            vi.advanceTimersByTime(50000)
            expect(triggeredTasks.length).toBe(0)
        })

        it('keeps the same task id after each recurring trigger', () => {
            const task = scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: Date.now() + 5000,
                message: 'Recurring',
                recurringMs: 10000,
            })

            vi.advanceTimersByTime(5000)
            expect(scheduler.listPending()[0].id).toBe(task.id)

            vi.advanceTimersByTime(10000)
            expect(scheduler.listPending()[0].id).toBe(task.id)
        })

        it('recurring task persistence includes recurringMs', () => {
            scheduler.schedule({
                topicKey: '12345:main',
                triggerAt: 1700000000000,
                message: 'Recurring',
                recurringMs: 10000,
            })

            const saved = scheduler.saveTasks()
            expect(saved[0].recurringMs).toBe(10000)
        })
    })
})
