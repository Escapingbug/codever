import type { SessionEvent } from './types'

export interface EventBus {
    emit(event: SessionEvent): void
    on(type: string, handler: (event: SessionEvent) => void | Promise<void>): () => void
    once(type: string, handler: (event: SessionEvent) => void | Promise<void>): () => void
    removeAllListeners(type?: string): void
}

export class DefaultEventBus implements EventBus {
    private handlers = new Map<string, Set<(event: SessionEvent) => void | Promise<void>>>()

    emit(event: SessionEvent): void {
        const handlers = this.handlers.get(event.type)
        if (!handlers) return
        for (const handler of handlers) {
            try {
                const result = handler(event)
                // Catch async handler rejections to prevent unhandled promise rejections
                if (result && typeof (result as any).catch === 'function') {
                    (result as any).catch((e: unknown) => {
                        console.error(`[EventBus] Async error in handler for ${event.type}:`, e)
                    })
                }
            } catch (e) {
                console.error(`[EventBus] Error in handler for ${event.type}:`, e)
            }
        }
    }

    on(type: string, handler: (event: SessionEvent) => void | Promise<void>): () => void {
        let set = this.handlers.get(type)
        if (!set) {
            set = new Set()
            this.handlers.set(type, set)
        }
        set.add(handler)
        return () => {
            set!.delete(handler)
            if (set!.size === 0) {
                this.handlers.delete(type)
            }
        }
    }

    once(type: string, handler: (event: SessionEvent) => void | Promise<void>): () => void {
        const wrapper = (event: SessionEvent) => {
            unsub()
            handler(event)
        }
        const unsub = this.on(type, wrapper)
        return unsub
    }

    removeAllListeners(type?: string): void {
        if (type) {
            this.handlers.delete(type)
        } else {
            this.handlers.clear()
        }
    }
}
