import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { JsonLineRpcPeer } from './jsonLineRpcPeer'
import { SessionCredentialBarrier } from './sessionCredentialBarrier'

export interface MatrixSessionCredential {
    homeserver: string
    userId: string
    deviceId: string
    accessToken: string
    refreshToken?: string
}

export interface NativeMatrixEvent {
    roomId: string
    event: Record<string, unknown>
    encrypted: boolean
    verifiedDevice: boolean
    senderDevice?: string
}

export interface MatrixSendInput {
    roomId: string
    eventType: string
    transactionId: string
    content: unknown
}

export interface NativeMatrixVerification {
    flowId: string
    stage: 'created' | 'requested' | 'ready' | 'sas' | 'present_sas' | 'done' | 'cancelled' | 'unsupported'
    weStarted?: boolean
    otherDeviceId?: string
    emojis?: Array<{ symbol: string; description: string }>
    cancellation?: { code: string; reason: string; cancelledByUs: boolean }
}

export interface NativeMatrixDevice {
    deviceId: string
    displayName?: string
    verified: boolean
    current: boolean
}

export interface MatrixTransport {
    initialize(): Promise<void>
    send(input: MatrixSendInput): Promise<string>
    downloadEncryptedFile?(encryptedFile: Record<string, unknown>, destinationPath: string): Promise<void>
    trustDevice?(deviceId: string): Promise<void>
    listVerifications?(): Promise<NativeMatrixVerification[]>
    advanceVerification?(flowId: string): Promise<NativeMatrixVerification>
    confirmVerification?(flowId: string, matches: boolean): Promise<NativeMatrixVerification>
    onEvent(listener: (event: NativeMatrixEvent) => void): () => void
    close(): Promise<void>
}

export interface NativeMatrixTransportOptions {
    executablePath: string
    session: MatrixSessionCredential
    storePath: string
    storePassphrase: string
    onSessionCredential?: (session: MatrixSessionCredential) => Promise<void>
    onError?: (error: Error) => void
}

export class NativeMatrixTransport implements MatrixTransport {
    private process?: ChildProcessWithoutNullStreams
    private peer?: JsonLineRpcPeer
    private readonly listeners = new Set<(event: NativeMatrixEvent) => void>()
    private readonly credentialBarrier = new SessionCredentialBarrier<MatrixSessionCredential>(
        session => this.options.onSessionCredential?.(session) ?? Promise.resolve(),
    )

    constructor(private readonly options: NativeMatrixTransportOptions) {}

    async initialize(): Promise<void> {
        if (this.peer) return
        const child = spawn(this.options.executablePath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false,
        })
        this.process = child
        const peer = new JsonLineRpcPeer(child.stdout, child.stdin, 60_000)
        this.peer = peer
        peer.onNotification(notification => {
            if (notification.method === 'event' && isNativeMatrixEvent(notification.params)) {
                for (const listener of this.listeners) listener(notification.params)
            } else if (notification.method === 'sync_error') {
                this.report(new Error(`Matrix sync failed: ${notificationMessage(notification.params)}`))
            } else if (notification.method === 'lagged') {
                this.report(new Error(`Matrix event consumer lagged: ${notificationMessage(notification.params)}`))
            } else if (notification.method === 'session_tokens' && isMatrixSessionCredential(notification.params)) {
                const session = notification.params
                this.credentialBarrier.enqueue(session)
                void this.credentialBarrier.flush().catch(error => {
                    this.report(new Error('Unable to persist refreshed Matrix credentials', { cause: error }))
                })
            } else if (notification.method === 'session_error') {
                this.report(new Error(notificationMessage(notification.params)))
            }
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', value => this.report(new Error(`Matrix transport: ${String(value).trim()}`)))
        child.on('error', error => this.report(new Error('Matrix transport process failed', { cause: error })))
        child.on('exit', (code, signal) => {
            peer.close(new Error(`Matrix transport exited (${code ?? signal ?? 'unknown'})`))
            if (this.process === child) {
                this.process = undefined
                this.peer = undefined
            }
        })
        try {
            await peer.request('initialize', {
                session: this.options.session,
                storePath: this.options.storePath,
                storePassphrase: this.options.storePassphrase,
            })
        } catch (error) {
            await this.close()
            throw error
        }
    }

    async send(input: MatrixSendInput): Promise<string> {
        const peer = this.peer
        if (!peer) throw new Error('Matrix transport is not initialized')
        let result: { eventId: string }
        try {
            result = await peer.request<{ eventId: string }>('send', input)
        } catch (error) {
            const bytes = Buffer.byteLength(JSON.stringify(input.content), 'utf8')
            throw new Error(`Matrix send ${input.eventType} failed (${bytes} plaintext bytes)`, { cause: error })
        }
        if (!result || typeof result.eventId !== 'string') throw new Error('Matrix transport returned no event ID')
        return result.eventId
    }

    async downloadEncryptedFile(encryptedFile: Record<string, unknown>, destinationPath: string): Promise<void> {
        await this.requirePeer().request('media.download', { encryptedFile, destinationPath })
    }

    async listDevices(): Promise<NativeMatrixDevice[]> {
        return this.requirePeer().request('devices.list', {})
    }

    async trustDevice(deviceId: string): Promise<void> {
        await this.requirePeer().request('device.trust', { deviceId })
    }

    async listVerifications(): Promise<NativeMatrixVerification[]> {
        return this.requirePeer().request('verification.list', {})
    }

    async advanceVerification(flowId: string): Promise<NativeMatrixVerification> {
        return this.requirePeer().request('verification.advance', { flowId })
    }

    async confirmVerification(flowId: string, matches: boolean): Promise<NativeMatrixVerification> {
        return this.requirePeer().request('verification.confirm', { flowId, matches })
    }

    onEvent(listener: (event: NativeMatrixEvent) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    async close(): Promise<void> {
        const child = this.process
        const peer = this.peer
        let persistenceError: unknown
        if (peer && this.options.onSessionCredential) {
            try {
                const session = await peer.request<MatrixSessionCredential>('session.checkpoint', {})
                if (!isMatrixSessionCredential(session)) {
                    throw new Error('Matrix transport returned an invalid session checkpoint')
                }
                this.credentialBarrier.enqueue(session)
                await this.credentialBarrier.flush()
            } catch (error) {
                persistenceError = error
                this.report(new Error('Unable to checkpoint Matrix credentials before shutdown', { cause: error }))
            }
        }
        this.process = undefined
        this.peer?.close()
        this.peer = undefined
        if (child && child.exitCode === null) {
            child.kill()
            await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, 5_000)
                child.once('exit', () => { clearTimeout(timer); resolve() })
            })
        }
        if (persistenceError) {
            throw new Error('Matrix credentials were not durable at shutdown', { cause: persistenceError })
        }
    }

    private report(error: Error): void {
        this.options.onError?.(error)
    }

    private requirePeer(): JsonLineRpcPeer {
        if (!this.peer) throw new Error('Matrix transport is not initialized')
        return this.peer
    }
}

function isMatrixSessionCredential(value: unknown): value is MatrixSessionCredential {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && typeof (value as MatrixSessionCredential).homeserver === 'string'
        && typeof (value as MatrixSessionCredential).userId === 'string'
        && typeof (value as MatrixSessionCredential).deviceId === 'string'
        && typeof (value as MatrixSessionCredential).accessToken === 'string'
        && ((value as MatrixSessionCredential).refreshToken === undefined
            || typeof (value as MatrixSessionCredential).refreshToken === 'string')
}

function isNativeMatrixEvent(value: unknown): value is NativeMatrixEvent {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && typeof (value as NativeMatrixEvent).roomId === 'string'
        && !!(value as NativeMatrixEvent).event && typeof (value as NativeMatrixEvent).event === 'object'
        && typeof (value as NativeMatrixEvent).encrypted === 'boolean'
        && typeof (value as NativeMatrixEvent).verifiedDevice === 'boolean'
}

function notificationMessage(value: unknown): string {
    if (value && typeof value === 'object' && 'message' in value) return String(value.message)
    return JSON.stringify(value)
}
