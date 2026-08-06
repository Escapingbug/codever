import type {
    JsonValue,
    SessionExtensionBinding,
    SessionExtensionDescriptor,
    SessionExtensionSummary,
} from '@codever/protocol'
import type { ConversationEvent, RichUserInput } from './semantic'
import {
    normalizeDeclarativeExtensionConfig,
    type ReadySessionExtensionTurn,
    type SessionExtensionContext,
    type SessionExtensionInstance,
    type SessionExtensionLifecycleReason,
    type SessionExtensionProvider,
    type SessionExtensionTurnContext,
    type SessionExtensionTurnPreparation,
} from './sessionExtensions'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_ERROR_CHARS = 500

export interface HttpSessionExtensionProviderOptions {
    descriptor: SessionExtensionDescriptor
    endpoint: string
    bearerToken: string
    timeoutMs?: number
    fetch?: typeof fetch
}

/**
 * Generic process boundary for high-trust session extensions. The endpoint is
 * deliberately loopback-only; remote registration is outside the trust model.
 */
export class HttpSessionExtensionProvider implements SessionExtensionProvider {
    readonly descriptor: SessionExtensionDescriptor
    private readonly endpoint: string
    private readonly bearerToken: string
    private readonly timeoutMs: number
    private readonly fetchImpl: typeof fetch

    constructor(options: HttpSessionExtensionProviderOptions) {
        const endpoint = new URL(options.endpoint)
        if (
            endpoint.protocol !== 'http:'
            || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
            || endpoint.username
            || endpoint.password
            || endpoint.search
            || endpoint.hash
        ) {
            throw new Error('Session extension endpoint must use loopback HTTP')
        }
        if (Buffer.byteLength(options.bearerToken, 'utf8') < 32) {
            throw new Error('Session extension bearer token must contain at least 32 bytes')
        }
        this.descriptor = structuredClone(options.descriptor)
        this.endpoint = endpoint.toString().replace(/\/$/u, '')
        this.bearerToken = options.bearerToken
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        this.fetchImpl = options.fetch ?? fetch
    }

    normalizeConfig(config: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
        return normalizeDeclarativeExtensionConfig(this.descriptor, config)
    }

    create(binding: SessionExtensionBinding, context: SessionExtensionContext): SessionExtensionInstance {
        return new HttpSessionExtensionInstance(
            this.descriptor,
            this.endpoint,
            this.bearerToken,
            binding,
            context,
            this.timeoutMs,
            this.fetchImpl,
        )
    }
}

class HttpSessionExtensionInstance implements SessionExtensionInstance {
    readonly id: string
    readonly summary: SessionExtensionSummary

    constructor(
        descriptor: SessionExtensionDescriptor,
        private readonly endpoint: string,
        private readonly bearerToken: string,
        private readonly binding: SessionExtensionBinding,
        private readonly session: SessionExtensionContext,
        private readonly timeoutMs: number,
        private readonly fetchImpl: typeof fetch,
    ) {
        this.id = descriptor.id
        this.summary = {
            id: descriptor.id,
            name: descriptor.name,
            version: descriptor.version,
        }
    }

    async prepareTurn(
        input: string | RichUserInput,
        context: SessionExtensionTurnContext,
    ): Promise<SessionExtensionTurnPreparation> {
        const response = await this.request('/v1/turns/prepare', {
            session: this.sessionPayload(),
            turn: context,
            binding: this.binding,
            input,
        })
        if (response.kind === 'ready') return readyTurn(response)
        if (response.kind !== 'approval_required') {
            throw new Error(`${this.id} returned an invalid turn preparation`)
        }
        const token = requireText(response.preparationToken, 'preparation token')
        const approval = requireRecord(response.approval, 'approval')
        const title = requireText(approval.title, 'approval title')
        return {
            kind: 'approval_required',
            approval: {
                title,
                ...(typeof approval.details === 'string' ? { details: approval.details } : {}),
                ...(typeof approval.approveLabel === 'string'
                    ? { approveLabel: approval.approveLabel }
                    : {}),
                ...(typeof approval.denyLabel === 'string'
                    ? { denyLabel: approval.denyLabel }
                    : {}),
            },
            approve: async () => readyTurn(await this.request('/v1/turns/commit', {
                session: this.sessionPayload(),
                turn: context,
                preparationToken: token,
            })),
            reject: async () => {
                await this.request('/v1/turns/reject', {
                    session: this.sessionPayload(),
                    turn: context,
                    preparationToken: token,
                })
            },
        }
    }

    async presentEvent(
        event: ConversationEvent,
        context: SessionExtensionTurnContext,
        stateRef?: string,
    ): Promise<ConversationEvent[]> {
        // provider_raw is journal-only and never projects to a channel. Do not
        // move the wrapped provider envelope across the process boundary.
        if (event.kind === 'provider_raw') return []
        const response = await this.request('/v1/events/present', {
            session: this.sessionPayload(),
            turn: context,
            stateRef,
            event: publicConversationEvent(event),
        })
        if (!Array.isArray(response.events)) {
            throw new Error(`${this.id} returned invalid display events`)
        }
        if (!response.events.every(isConversationEvent)) {
            throw new Error(`${this.id} returned malformed display events`)
        }
        return response.events
    }

    async lifecycle(reason: SessionExtensionLifecycleReason): Promise<void> {
        await this.request('/v1/sessions/lifecycle', {
            session: this.sessionPayload(),
            binding: this.binding,
            reason,
        })
    }

    private sessionPayload(): Record<string, string> {
        return {
            sessionId: this.session.sessionId,
            cwd: this.session.cwd,
            providerName: this.session.providerName,
        }
    }

    private async request(path: string, body: unknown): Promise<Record<string, unknown>> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
            let response: Response
            try {
                response = await this.fetchImpl(`${this.endpoint}${path}`, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${this.bearerToken}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                })
            } catch (error) {
                const detail = controller.signal.aborted ? 'timed out' : safeError(error)
                throw new Error(`Session extension ${this.id} is unavailable: ${detail}`)
            }
            let payload: unknown
            try {
                payload = await response.json()
            } catch {
                throw new Error(`Session extension ${this.id} returned an invalid response`)
            }
            const record = requireRecord(payload, 'response')
            if (!response.ok) {
                const detail = typeof record.error === 'string'
                    ? record.error.slice(0, MAX_ERROR_CHARS)
                    : `HTTP ${response.status}`
                throw new Error(`Session extension ${this.id} blocked the operation: ${detail}`)
            }
            return record
        } finally {
            clearTimeout(timer)
        }
    }
}

function readyTurn(value: Record<string, unknown>): ReadySessionExtensionTurn {
    if (value.kind !== 'ready') throw new Error('Session extension did not commit a ready turn')
    const input = value.input
    if (!isExtensionInput(input)) throw new Error('Session extension returned an invalid provider input')
    return {
        kind: 'ready',
        input,
        ...(typeof value.stateRef === 'string' ? { stateRef: value.stateRef } : {}),
    }
}

function isExtensionInput(value: unknown): value is string | RichUserInput {
    if (typeof value === 'string') return true
    const record = asRecord(value)
    return Array.isArray(record?.parts) && record.parts.every(part => {
        const candidate = asRecord(part)
        if (!candidate || typeof candidate.type !== 'string') return false
        if (candidate.type === 'text') return typeof candidate.text === 'string'
        if (candidate.type === 'image' || candidate.type === 'audio') {
            return typeof candidate.mimeType === 'string' && typeof candidate.data === 'string'
        }
        if (candidate.type === 'file') {
            return typeof candidate.path === 'string'
                && typeof candidate.filename === 'string'
                && typeof candidate.mimeType === 'string'
                && typeof candidate.sizeBytes === 'number'
                && Number.isFinite(candidate.sizeBytes)
                && candidate.sizeBytes >= 0
        }
        return false
    })
}

function publicConversationEvent(event: ConversationEvent): ConversationEvent {
    const { raw: _raw, ...meta } = event.meta
    return {
        ...event,
        meta,
    }
}

function isConversationEvent(value: unknown): value is ConversationEvent {
    const record = asRecord(value)
    const meta = asRecord(record?.meta)
    if (
        !record
        || !meta
        || typeof meta.id !== 'string'
        || typeof meta.sessionId !== 'string'
        || typeof meta.turnId !== 'string'
        || typeof meta.provider !== 'string'
        || !Number.isSafeInteger(meta.seq)
        || typeof meta.timestamp !== 'number'
        || !Number.isFinite(meta.timestamp)
        || !['live', 'replay', 'tailDrain', 'synthetic'].includes(String(meta.sourcePhase))
    ) return false
    if (record.kind === 'assistant_text_delta') return typeof record.text === 'string'
    return [
        'turn_started',
        'tool',
        'decision_request',
        'mode_change',
        'command_result',
        'turn_finished',
        'provider_raw',
    ].includes(String(record.kind))
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
    const record = asRecord(value)
    if (!record) throw new Error(`Session extension ${name} is invalid`)
    return record
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function requireText(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Session extension ${name} is invalid`)
    return value
}

function safeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS)
}
