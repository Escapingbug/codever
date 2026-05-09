/**
 * ServerManager — manages the `opencode serve` child process lifecycle.
 *
 * Responsibilities:
 * - Spawn `opencode serve` on a free port
 * - Wait for server to become ready (health check polling)
 * - Detect server crash and auto-restart (up to 5 retries)
 * - Provide the baseUrl for SDK client creation
 * - Clean shutdown on dispose
 */

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

export interface ServerState {
    baseUrl: string
    port: number
}

type ServerEventCallback = (event: { type: 'started'; state: ServerState } | { type: 'stopped' }) => void

export class ServerManager {
    private serverProcess: ChildProcess | null = null
    private retryCount = 0
    private maxRetries = 5
    private _state: ServerState | null = null
    private _isShuttingDown = false
    private listeners = new Set<ServerEventCallback>()
    private _initError: string | null = null

    get state(): ServerState | null { return this._state }
    get isRunning(): boolean { return this.serverProcess !== null && !this.serverProcess.killed }
    get initError(): string | null { return this._initError }

    onStateChange(cb: ServerEventCallback): () => void {
        this.listeners.add(cb)
        return () => { this.listeners.delete(cb) }
    }

    private notify(event: Parameters<ServerEventCallback>[0]): void {
        for (const cb of this.listeners) cb(event)
    }

    /**
     * Start the opencode serve process.
     * Returns the ServerState on success, throws on failure.
     */
    async start(cwd?: string): Promise<ServerState> {
        this._isShuttingDown = false
        this._initError = null

        const port = await this.findFreePort()
        await this.spawnServer(port, cwd)

        this._state = { baseUrl: `http://127.0.0.1:${port}`, port }
        this.notify({ type: 'started', state: this._state })
        return this._state
    }

    /**
     * Restart the server after a crash.
     */
    async restart(cwd?: string): Promise<ServerState> {
        console.error(`[opencode-server] Restarting (attempt ${this.retryCount + 1})...`)
        this.kill()
        this._state = null
        return this.start(cwd)
    }

    /**
     * Gracefully shut down the server.
     */
    dispose(): void {
        this._isShuttingDown = true
        this.kill()
        this._state = null
        this.notify({ type: 'stopped' })
    }

    private kill(): void {
        if (this.serverProcess && !this.serverProcess.killed) {
            try {
                if (process.platform === 'win32' && this.serverProcess.pid) {
                    // Windows: force-kill the process tree
                    spawn('taskkill', ['/PID', this.serverProcess.pid.toString(), '/T', '/F'], {
                        windowsHide: true,
                        stdio: 'ignore',
                    })
                } else {
                    this.serverProcess.kill('SIGTERM')
                }
            } catch {}
        }
        this.serverProcess = null
    }

    private async spawnServer(port: number, cwd?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const serverProcess = spawn('opencode', ['serve', '--port', port.toString(), '--print-logs', '--log-level', 'WARN'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: cwd || undefined,
                windowsHide: true,
            })

            let resolved = false
            this.serverProcess = serverProcess

            serverProcess.stdout?.on('data', (data: Buffer) => {
                const text = data.toString('utf-8').trim()
                if (text) console.error(`[opencode-server] ${text.substring(0, 200)}`)
            })

            serverProcess.stderr?.on('data', (data: Buffer) => {
                const text = data.toString('utf-8').trim()
                if (text) console.error(`[opencode-server] ${text.substring(0, 200)}`)
            })

            serverProcess.on('close', (code) => {
                console.error(`[opencode-server] Process exited with code ${code}`)
                this.serverProcess = null
                this._state = null

                if (!resolved) {
                    this._initError = `Server exited before ready (code=${code})`
                    reject(new Error(this._initError))
                    return
                }

                // Server crashed after being ready
                this.notify({ type: 'stopped' })

                // Auto-restart on crash (unless shutting down)
                if (!this._isShuttingDown && code !== 0) {
                    this.retryCount++
                    if (this.retryCount <= this.maxRetries) {
                        console.error(`[opencode-server] Auto-restarting (retry ${this.retryCount}/${this.maxRetries})...`)
                        this.restart(cwd).catch((e) => {
                            console.error(`[opencode-server] Auto-restart failed: ${e instanceof Error ? e.message : String(e)}`)
                        })
                    } else {
                        console.error(`[opencode-server] Exceeded max retries (${this.maxRetries}), giving up`)
                    }
                }
            })

            serverProcess.on('error', (err) => {
                console.error(`[opencode-server] Process error: ${err.message}`)
                if (!resolved) {
                    this._initError = `Server process error: ${err.message}`
                    reject(err)
                }
            })

            // Wait for server to become ready
            this.waitForReady(port, 30_000).then(() => {
                resolved = true
                this.retryCount = 0 // Reset on successful start
                resolve()
            }).catch((e) => {
                if (!resolved) {
                    this._initError = e instanceof Error ? e.message : String(e)
                    reject(e)
                }
            })
        })
    }

    /**
     * Poll the server's health endpoint until it responds.
     */
    async waitForReady(port: number, maxWaitMs = 30_000): Promise<void> {
        const start = Date.now()
        while (Date.now() - start < maxWaitMs) {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/health`)
                if (response.ok) return
            } catch {}
            await new Promise(r => setTimeout(r, 300))
        }
        throw new Error(`Server did not become ready within ${maxWaitMs}ms`)
    }

    /**
     * Check if the server is currently healthy.
     */
    async isHealthy(): Promise<boolean> {
        if (!this._state) return false
        try {
            const response = await fetch(`${this._state.baseUrl}/api/health`)
            return response.ok
        } catch {
            return false
        }
    }

    private findFreePort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = net.createServer()
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address()
                if (addr && typeof addr === 'object') {
                    const port = addr.port
                    server.close(() => resolve(port))
                } else {
                    server.close(() => reject(new Error('Could not determine port')))
                }
            })
            server.on('error', reject)
        })
    }
}
