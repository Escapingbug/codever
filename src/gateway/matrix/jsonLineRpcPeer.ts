import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'

export interface JsonLineNotification {
    method: string
    params: unknown
}

interface RpcResponse {
    id?: string
    result?: unknown
    error?: { code: string; message: string }
    method?: string
    params?: unknown
}

export class JsonLineRpcPeer {
    private readonly pending = new Map<string, {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
        timer: ReturnType<typeof setTimeout>
    }>()
    private readonly notificationListeners = new Set<(notification: JsonLineNotification) => void>()
    private closed = false

    constructor(
        input: Readable,
        private readonly output: Writable,
        private readonly timeoutMs = 30_000,
    ) {
        const lines = createInterface({ input, crlfDelay: Infinity })
        lines.on('line', line => this.receive(line))
        lines.on('close', () => this.close(new Error('Matrix transport IPC closed')))
    }

    request<T>(method: string, params: unknown = {}): Promise<T> {
        if (this.closed) return Promise.reject(new Error('Matrix transport IPC is closed'))
        const id = randomUUID()
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Matrix transport IPC request timed out: ${method}`))
            }, this.timeoutMs)
            timer.unref?.()
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
            this.output.write(`${JSON.stringify({ id, method, params })}\n`, error => {
                if (!error) return
                clearTimeout(timer)
                this.pending.delete(id)
                reject(new Error(`Unable to write Matrix transport IPC request: ${method}`, { cause: error }))
            })
        })
    }

    onNotification(listener: (notification: JsonLineNotification) => void): () => void {
        this.notificationListeners.add(listener)
        return () => this.notificationListeners.delete(listener)
    }

    close(reason = new Error('Matrix transport IPC closed')): void {
        if (this.closed) return
        this.closed = true
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(reason)
        }
        this.pending.clear()
        this.notificationListeners.clear()
    }

    private receive(line: string): void {
        let response: RpcResponse
        try {
            response = JSON.parse(line) as RpcResponse
        } catch {
            this.close(new Error('Matrix transport emitted invalid JSON'))
            return
        }
        if (typeof response.id === 'string') {
            const pending = this.pending.get(response.id)
            if (!pending) return
            this.pending.delete(response.id)
            clearTimeout(pending.timer)
            if (response.error) pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
            else pending.resolve(response.result)
            return
        }
        if (typeof response.method === 'string') {
            for (const listener of this.notificationListeners) listener({
                method: response.method,
                params: response.params,
            })
        }
    }
}
