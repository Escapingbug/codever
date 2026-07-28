import { createHash } from 'node:crypto'
import type { SessionInput } from '@/runtime/semantic'
import { CODEVER_MATRIX_EXTENSION, CODEVER_MATRIX_PROTOCOL_VERSION } from './matrixPort'
import type { MatrixIncomingEvent } from './transport'
import type { MatrixPinnedDeviceStore, MatrixReplayFingerprintStore } from './stores'

export interface MatrixRoomSessionTarget {
    dispatch(input: SessionInput): Promise<unknown>
    resolveDecision?(decisionId: string, value: string): boolean
}

export class MatrixRoomSessionRegistry {
    private readonly targets = new Map<string, MatrixRoomSessionTarget>()

    bind(roomId: string, target: MatrixRoomSessionTarget): void {
        this.targets.set(roomId, target)
    }

    unbind(roomId: string, target?: MatrixRoomSessionTarget): boolean {
        if (target && this.targets.get(roomId) !== target) return false
        return this.targets.delete(roomId)
    }

    get(roomId: string): MatrixRoomSessionTarget | undefined {
        return this.targets.get(roomId)
    }
}

export type MatrixRouteResult =
    | { status: 'handled'; inputKind: SessionInput['kind'] }
    | {
        status: 'rejected'
        reason:
            | 'not-encrypted'
            | 'missing-device'
            | 'missing-ciphertext-fingerprint'
            | 'device-not-pinned'
            | 'replay'
            | 'invalid-content'
            | 'unsigned-command'
            | 'authorization-failed'
            | 'unknown-decision'
    }
    | { status: 'ignored'; reason: 'unsupported-event' | 'unmapped-room' }

export interface MatrixIncomingRouterOptions {
    sessions: MatrixRoomSessionRegistry
    pinnedDevices: MatrixPinnedDeviceStore
    replayFingerprints: MatrixReplayFingerprintStore
    /**
     * Strict mode is the production default: Matrix E2EE is transport privacy,
     * while a separately pinned Codever key is the authority to control the
     * agent. Compatibility mode accepts commands from locally pinned Matrix
     * devices for use with existing Matrix clients.
     */
    authorizationMode?: 'strict' | 'compatibility'
    verifySignedCommand?: (
        envelope: unknown,
        event: MatrixIncomingEvent,
    ) => Promise<SessionInput | readonly SessionInput[] | null>
}

export class MatrixIncomingRouter {
    constructor(private readonly options: MatrixIncomingRouterOptions) {}

    async route(event: MatrixIncomingEvent): Promise<MatrixRouteResult> {
        if (event.eventType !== 'm.room.message') {
            return { status: 'ignored', reason: 'unsupported-event' }
        }
        if (!event.encrypted) {
            return { status: 'rejected', reason: 'not-encrypted' }
        }
        if (!event.senderDeviceId) {
            return { status: 'rejected', reason: 'missing-device' }
        }
        if (!event.encryptedPayloadFingerprint) {
            return { status: 'rejected', reason: 'missing-ciphertext-fingerprint' }
        }

        const target = this.options.sessions.get(event.roomId)
        if (!target) return { status: 'ignored', reason: 'unmapped-room' }

        const pinned = await this.options.pinnedDevices.isPinned(
            event.roomId,
            event.sender,
            event.senderDeviceId,
        )
        if (!pinned) return { status: 'rejected', reason: 'device-not-pinned' }

        let parsedInput: SessionInput | readonly SessionInput[] | null
        const authorizationMode = this.options.authorizationMode ?? 'strict'
        if (authorizationMode === 'strict') {
            const extension = asRecord(event.content[CODEVER_MATRIX_EXTENSION])
            if (
                !extension ||
                extension.version !== CODEVER_MATRIX_PROTOCOL_VERSION ||
                extension.kind !== 'signed_command'
            ) {
                return { status: 'rejected', reason: 'unsigned-command' }
            }
            if (!this.options.verifySignedCommand) {
                return { status: 'rejected', reason: 'authorization-failed' }
            }
            try {
                parsedInput = await this.options.verifySignedCommand(extension.envelope, event)
            } catch {
                return { status: 'rejected', reason: 'authorization-failed' }
            }
        } else {
            parsedInput = parseSessionInput(event)
        }
        if (!parsedInput) return { status: 'rejected', reason: 'invalid-content' }
        const inputs = Array.isArray(parsedInput) ? parsedInput : [parsedInput]
        if (inputs.length === 0) return { status: 'rejected', reason: 'invalid-content' }

        const replayFingerprint = fingerprintCiphertext(event.encryptedPayloadFingerprint)
        if (!await this.options.replayFingerprints.claim(replayFingerprint)) {
            return { status: 'rejected', reason: 'replay' }
        }

        for (const input of inputs) {
            if (input.kind === 'decision_response' && target.resolveDecision) {
                if (!target.resolveDecision(input.decisionId, String(input.value))) {
                    return { status: 'rejected', reason: 'unknown-decision' }
                }
                continue
            }
            await target.dispatch(input)
        }

        return { status: 'handled', inputKind: inputs[0].kind }
    }
}

function parseSessionInput(event: MatrixIncomingEvent): SessionInput | null {
    const extension = event.content[CODEVER_MATRIX_EXTENSION]
    if (extension !== undefined) {
        return parseCodeverInput(extension, event)
    }

    if (event.content.msgtype !== 'm.text' || typeof event.content.body !== 'string') return null
    return parseStandardText(event.content.body, event)
}

function parseCodeverInput(value: unknown, event: MatrixIncomingEvent): SessionInput | null {
    const extension = asRecord(value)
    if (!extension || extension.version !== CODEVER_MATRIX_PROTOCOL_VERSION) return null
    const user = { id: event.sender, username: event.sender, displayName: event.sender }

    switch (extension.kind) {
        case 'user_message': {
            const text = typeof extension.text === 'string'
                ? extension.text
                : typeof event.content.body === 'string'
                    ? event.content.body
                    : null
            return text === null ? null : { kind: 'user_message', text, source: 'channel', user }
        }
        case 'command':
            if (typeof extension.name !== 'string' || !extension.name.trim()) return null
            return {
                kind: 'command',
                name: extension.name,
                ...(typeof extension.args === 'string' ? { args: extension.args } : {}),
                source: 'channel',
                user,
            }
        case 'cancel':
            return { kind: 'cancel', reason: 'user', source: 'channel', user }
        case 'decision_response':
            if (typeof extension.decision_id !== 'string' || typeof extension.value !== 'string') return null
            return {
                kind: 'decision_response',
                decisionId: extension.decision_id,
                value: extension.value,
                source: 'channel',
                user,
            }
        default:
            return null
    }
}

function parseStandardText(text: string, event: MatrixIncomingEvent): SessionInput {
    const trimmed = text.trim()
    const command = trimmed.match(/^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/)
    const user = { id: event.sender, username: event.sender, displayName: event.sender }
    if (!command) return { kind: 'user_message', text, source: 'channel', user }

    const name = command[1]
    if (name === 'stop' || name === 'cancel') {
        return { kind: 'cancel', reason: 'user', source: 'channel', user }
    }
    return {
        kind: 'command',
        name,
        ...(command[2] ? { args: command[2] } : {}),
        source: 'channel',
        user,
    }
}

function fingerprintCiphertext(encryptedPayloadFingerprint: string): string {
    return createHash('sha256')
        .update('codever-matrix-replay:v1\0')
        .update(encryptedPayloadFingerprint)
        .digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}
