import { randomUUID } from 'node:crypto'
import { sessionExtensionViewSchema } from '@codever/protocol'
import { contentDigest, PrivacyAuditLog } from './audit.js'
import { mappingFindingCount, mergeMappings, restoreText } from './mapping.js'
import { HAS_SESSION_EXTENSION_ID } from './manifest.js'
import type {
    ConversationEvent,
    ExtensionBinding,
    ExtensionInput,
    ExtensionSession,
    ExtensionTurn,
    HasAdapter,
    HasMapping,
} from './types.js'
import { EncryptedMappingVault } from './vault.js'

type RichExtensionInput = Exclude<ExtensionInput, string>

const DEFAULT_ENTITY_TYPES = [
    '个人姓名',
    '手机号码',
    '身份证号',
    '银行卡号',
    '电子邮箱',
    '员工编号',
    '组织机构',
    '地址地点',
]
const PREVIEW_TTL_MS = 10 * 60_000

interface Preview {
    token: string
    expiresAt: number
    sessionId: string
    turnId: string
    providerName: string
    contextId: string
    baseVersion: number
    sanitizedInput: ExtensionInput
    mappingDelta: HasMapping
    findingCount: number
    sourceDigest: string
    sanitizedDigest: string
}

interface DisplayState {
    sessionId: string
    turnId: string
    providerName: string
    contextId: string
    mappingVersion: number
}

export interface HasSessionExtensionServiceOptions {
    adapter: HasAdapter
    vault: EncryptedMappingVault
    audit: PrivacyAuditLog
    now?: () => number
    entityTypes?: readonly string[]
}

export class HasSessionExtensionService {
    private readonly previews = new Map<string, Preview>()
    private readonly committed = new Map<string, { input: ExtensionInput; stateRef: string }>()
    private readonly displayStates = new Map<string, DisplayState>()
    private readonly assistantBuffers = new Map<string, string>()
    private readonly now: () => number
    private readonly entityTypes: readonly string[]

    constructor(private readonly options: HasSessionExtensionServiceOptions) {
        this.now = options.now ?? Date.now
        this.entityTypes = options.entityTypes ?? DEFAULT_ENTITY_TYPES
    }

    async prepare(body: unknown): Promise<Record<string, unknown>> {
        this.prune()
        const request = parseTurnRequest(body)
        const config = parseBinding(request.binding)
        const current = await this.options.vault.current(config.contextId)
        const sanitized = await sanitizeInput(
            request.input,
            current.mapping,
            this.options.adapter,
            this.entityTypes,
        )
        const findingCount = mappingFindingCount(
            inputText(sanitized.input),
            mergeMappings(current.mapping, sanitized.delta),
        )
        const preview: Preview = {
            token: randomUUID(),
            expiresAt: this.now() + PREVIEW_TTL_MS,
            sessionId: request.session.sessionId,
            turnId: request.turn.turnId,
            providerName: request.turn.providerName,
            contextId: config.contextId,
            baseVersion: current.version,
            sanitizedInput: sanitized.input,
            mappingDelta: sanitized.delta,
            findingCount,
            sourceDigest: contentDigest(inputText(request.input)),
            sanitizedDigest: contentDigest(inputText(sanitized.input)),
        }
        this.previews.set(preview.token, preview)
        await this.options.audit.append({
            action: 'prepare',
            status: 'succeeded',
            contextId: preview.contextId,
            sessionId: preview.sessionId,
            turnId: preview.turnId,
            findingCount,
            mappingVersion: preview.baseVersion,
            sourceDigest: preview.sourceDigest,
            sanitizedDigest: preview.sanitizedDigest,
            engine: this.options.adapter.identity,
        })

        if (!config.reviewRequired) return await this.commitPreview(preview)
        return {
            kind: 'interaction_required',
            preparationToken: preview.token,
            cancelActionId: 'cancel',
            view: sessionExtensionViewSchema.parse({
                version: 1,
                title: 'Privacy-protected Agent request',
                elements: [
                    {
                        type: 'status',
                        tone: findingCount > 0 ? 'warning' : 'success',
                        text: findingCount > 0
                            ? `${findingCount} private value${findingCount === 1 ? '' : 's'} replaced`
                            : 'No private values found',
                    },
                    {
                        type: 'readonly_textarea',
                        label: 'The Agent will receive exactly',
                        value: inputText(preview.sanitizedInput),
                    },
                ],
                actions: [
                    { id: 'send', label: 'Send to Agent', style: 'primary' },
                    { id: 'cancel', label: 'Cancel', style: 'secondary' },
                ],
            }),
        }
    }

    async respond(body: unknown): Promise<Record<string, unknown>> {
        this.prune()
        const record = requireRecord(body, 'interaction response')
        const token = requireText(record.preparationToken, 'preparationToken')
        const actionId = requireText(record.actionId, 'actionId')
        if (actionId === 'send') {
            const prior = this.committed.get(token)
            if (prior) return { kind: 'ready', input: prior.input, stateRef: prior.stateRef }
            return await this.commitPreview(this.requirePreview(token, record))
        }
        if (actionId === 'cancel') {
            await this.reject(record)
            return { kind: 'cancelled' }
        }
        throw new Error('Privacy interaction action is invalid')
    }

    async commit(body: unknown): Promise<Record<string, unknown>> {
        this.prune()
        const record = requireRecord(body, 'commit request')
        const token = requireText(record.preparationToken, 'preparationToken')
        const prior = this.committed.get(token)
        if (prior) return { kind: 'ready', input: prior.input, stateRef: prior.stateRef }
        const preview = this.requirePreview(token, record)
        return await this.commitPreview(preview)
    }

    async reject(body: unknown): Promise<Record<string, unknown>> {
        this.prune()
        const record = requireRecord(body, 'reject request')
        const token = requireText(record.preparationToken, 'preparationToken')
        const preview = this.previews.get(token)
        if (preview) {
            assertPreviewRequest(preview, record)
            this.previews.delete(token)
            await this.options.audit.append({
                action: 'reject',
                status: 'blocked',
                contextId: preview.contextId,
                sessionId: preview.sessionId,
                turnId: preview.turnId,
                findingCount: preview.findingCount,
                mappingVersion: preview.baseVersion,
                sourceDigest: preview.sourceDigest,
                sanitizedDigest: preview.sanitizedDigest,
                engine: this.options.adapter.identity,
            })
        }
        return { rejected: true }
    }

    async present(body: unknown): Promise<Record<string, unknown>> {
        const record = requireRecord(body, 'event request')
        const stateRef = requireText(record.stateRef, 'stateRef')
        const state = this.displayStates.get(stateRef)
        if (!state) throw new Error('Privacy display state is unavailable; output was blocked')
        const session = parseSession(record.session)
        const turn = parseTurn(record.turn)
        if (
            session.sessionId !== state.sessionId
            || turn.sessionId !== state.sessionId
            || turn.turnId !== state.turnId
            || session.providerName !== state.providerName
            || turn.providerName !== state.providerName
        ) {
            throw new Error('Privacy display scope mismatch')
        }
        const event = parseEvent(record.event)
        const mapping = await this.options.vault.get(state.contextId, state.mappingVersion)
        return { events: this.restoreEvent(event, mapping, stateRef, turn.turnId) }
    }

    async lifecycle(body: unknown): Promise<Record<string, unknown>> {
        const record = requireRecord(body, 'lifecycle request')
        const session = parseSession(record.session)
        const binding = parseBinding(record.binding)
        const reason = requireText(record.reason, 'reason')
        if (!['archive', 'delete', 'replace', 'shutdown'].includes(reason)) {
            throw new Error('Session lifecycle reason is invalid')
        }
        for (const [token, preview] of this.previews) {
            if (preview.sessionId === session.sessionId) this.previews.delete(token)
        }
        for (const [stateRef, state] of this.displayStates) {
            if (state.sessionId === session.sessionId) {
                this.displayStates.delete(stateRef)
                for (const key of this.assistantBuffers.keys()) {
                    if (key.startsWith(`${stateRef}\0`)) this.assistantBuffers.delete(key)
                }
            }
        }
        await this.options.audit.append({
            action: 'lifecycle',
            status: 'succeeded',
            contextId: binding.contextId,
            sessionId: session.sessionId,
            errorCode: reason,
        })
        return { handled: true }
    }

    private async commitPreview(preview: Preview): Promise<Record<string, unknown>> {
        const mappingVersion = await this.options.vault.commit({
            contextId: preview.contextId,
            expectedVersion: preview.baseVersion,
            delta: preview.mappingDelta,
            actorId: preview.sessionId,
            engine: this.options.adapter.identity,
        })
        const stateRef = randomUUID()
        await this.options.audit.append({
            action: 'commit',
            status: 'succeeded',
            contextId: preview.contextId,
            sessionId: preview.sessionId,
            turnId: preview.turnId,
            findingCount: preview.findingCount,
            mappingVersion,
            sourceDigest: preview.sourceDigest,
            sanitizedDigest: preview.sanitizedDigest,
            engine: this.options.adapter.identity,
        })
        this.previews.delete(preview.token)
        this.displayStates.set(stateRef, {
            sessionId: preview.sessionId,
            turnId: preview.turnId,
            providerName: preview.providerName,
            contextId: preview.contextId,
            mappingVersion,
        })
        this.committed.set(preview.token, { input: preview.sanitizedInput, stateRef })
        return { kind: 'ready', input: preview.sanitizedInput, stateRef }
    }

    private requirePreview(token: string, request: Record<string, unknown>): Preview {
        const preview = this.previews.get(token)
        if (!preview) throw new Error('Privacy preview is missing or expired')
        assertPreviewRequest(preview, request)
        return preview
    }

    private restoreEvent(
        event: ConversationEvent,
        mapping: HasMapping,
        stateRef: string,
        turnId: string,
    ): ConversationEvent[] {
        const bufferKey = `${stateRef}\0${turnId}`
        if (event.kind === 'assistant_text_delta') {
            const text = requireTextAllowEmpty(event.text, 'assistant delta')
            const pending = `${this.assistantBuffers.get(bufferKey) ?? ''}${text}`
            const { emitted, retained } = splitSafeStreamingText(pending, Object.keys(mapping))
            this.assistantBuffers.set(bufferKey, retained)
            return emitted
                ? [{ ...event, text: restoreText(emitted, mapping) }]
                : []
        }
        if (event.kind === 'turn_finished') {
            const pending = this.assistantBuffers.get(bufferKey) ?? ''
            this.assistantBuffers.delete(bufferKey)
            const restoredFinish = restoreEventFields(event, mapping)
            return pending
                ? [
                    { ...event, kind: 'assistant_text_delta', text: restoreText(pending, mapping) },
                    restoredFinish,
                ]
                : [restoredFinish]
        }
        return [restoreEventFields(event, mapping)]
    }

    private prune(): void {
        const now = this.now()
        for (const [token, preview] of this.previews) {
            if (preview.expiresAt <= now) this.previews.delete(token)
        }
        if (this.committed.size > 1_000) this.committed.clear()
    }
}

async function sanitizeInput(
    input: ExtensionInput,
    baseMapping: HasMapping,
    adapter: HasAdapter,
    entityTypes: readonly string[],
): Promise<{ input: ExtensionInput; delta: HasMapping }> {
    let mapping = baseMapping
    let delta: HasMapping = {}
    const sanitize = async (text: string): Promise<string> => {
        const hidden = await adapter.hide({ text, entityTypes, mapping })
        delta = mergeMappings(delta, hidden.mappingDelta)
        mapping = mergeMappings(mapping, hidden.mappingDelta)
        return hidden.anonymizedText
    }
    if (typeof input === 'string') return { input: await sanitize(input), delta }
    if (input.parts.length !== 1) {
        throw new Error('HaS privacy currently supports one text part per Agent request')
    }
    const parts: RichExtensionInput['parts'] = []
    for (const part of input.parts) {
        if (part.type !== 'text' || typeof part.text !== 'string') {
            throw new Error('HaS privacy currently supports text-only Agent requests')
        }
        parts.push({ ...part, text: await sanitize(part.text) })
    }
    return { input: { parts }, delta }
}

function splitSafeStreamingText(
    value: string,
    pseudonyms: readonly string[],
): { emitted: string; retained: string } {
    const maxLength = Math.max(0, ...pseudonyms.map(item => item.length))
    if (maxLength <= 1 || value.length < maxLength) return { emitted: maxLength ? '' : value, retained: maxLength ? value : '' }
    let cut = value.length - maxLength + 1
    for (const pseudonym of pseudonyms) {
        const start = value.lastIndexOf(pseudonym, cut)
        if (start >= 0 && start < cut && start + pseudonym.length > cut) cut = start
    }
    return { emitted: value.slice(0, cut), retained: value.slice(cut) }
}

function restoreEventFields(event: ConversationEvent, mapping: HasMapping): ConversationEvent {
    const restored: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(event)) {
        restored[key] = key === 'meta' ? value : restoreValue(value, mapping)
    }
    return restored as ConversationEvent
}

function restoreValue(value: unknown, mapping: HasMapping): unknown {
    if (typeof value === 'string') return restoreText(value, mapping)
    if (Array.isArray(value)) return value.map(item => restoreValue(item, mapping))
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, restoreValue(item, mapping)]),
        )
    }
    return value
}

function inputText(input: ExtensionInput): string {
    return typeof input === 'string'
        ? input
        : input.parts.map(part => part.text ?? '').join('\n')
}

function parseTurnRequest(value: unknown): {
    session: ExtensionSession
    turn: ExtensionTurn
    binding: ExtensionBinding
    input: ExtensionInput
} {
    const record = requireRecord(value, 'turn request')
    const session = parseSession(record.session)
    const turn = parseTurn(record.turn)
    if (
        session.sessionId !== turn.sessionId
        || session.providerName !== turn.providerName
    ) {
        throw new Error('Turn scope does not match the bound session')
    }
    return {
        session,
        turn,
        binding: parseRawBinding(record.binding),
        input: parseInput(record.input),
    }
}

function parseSession(value: unknown): ExtensionSession {
    const record = requireRecord(value, 'session')
    return {
        sessionId: requireText(record.sessionId, 'sessionId'),
        cwd: requireText(record.cwd, 'cwd'),
        providerName: requireText(record.providerName, 'providerName'),
    }
}

function parseTurn(value: unknown): ExtensionTurn {
    const record = requireRecord(value, 'turn')
    return {
        sessionId: requireText(record.sessionId, 'turn sessionId'),
        turnId: requireText(record.turnId, 'turnId'),
        providerName: requireText(record.providerName, 'turn providerName'),
    }
}

function parseRawBinding(value: unknown): ExtensionBinding {
    const record = requireRecord(value, 'binding')
    if (record.id !== HAS_SESSION_EXTENSION_ID) throw new Error('Wrong session extension binding')
    return {
        id: HAS_SESSION_EXTENSION_ID,
        config: requireRecord(record.config ?? {}, 'binding config'),
    }
}

function parseBinding(binding: ExtensionBinding | unknown): {
    contextId: string
    reviewRequired: boolean
} {
    const parsed = parseRawBinding(binding)
    const config = parsed.config ?? {}
    const unknownSetting = Object.keys(config).find(key =>
        key !== 'contextId' && key !== 'reviewRequired')
    if (unknownSetting) throw new Error(`Unknown HaS privacy setting ${unknownSetting}`)
    const contextId = requireText(config.contextId, 'privacy contextId').trim()
    if (contextId.length > 256) throw new Error('privacy contextId is too long')
    const reviewRequired = config.reviewRequired ?? true
    if (typeof reviewRequired !== 'boolean') throw new Error('reviewRequired must be boolean')
    return { contextId, reviewRequired }
}

function parseInput(value: unknown): ExtensionInput {
    if (typeof value === 'string') return value
    const record = requireRecord(value, 'input')
    if (!Array.isArray(record.parts)) throw new Error('Extension input parts are invalid')
    return {
        parts: record.parts.map(part =>
            requireRecord(part, 'input part') as RichExtensionInput['parts'][number]),
    }
}

function parseEvent(value: unknown): ConversationEvent {
    const record = requireRecord(value, 'conversation event')
    if (typeof record.kind !== 'string') throw new Error('Conversation event kind is invalid')
    requireRecord(record.meta, 'conversation event metadata')
    return record as ConversationEvent
}

function assertPreviewRequest(preview: Preview, record: Record<string, unknown>): void {
    const session = parseSession(record.session)
    const turn = parseTurn(record.turn)
    if (
        session.sessionId !== preview.sessionId
        || turn.sessionId !== preview.sessionId
        || turn.turnId !== preview.turnId
        || session.providerName !== preview.providerName
        || turn.providerName !== preview.providerName
    ) {
        throw new Error('Privacy preview scope mismatch')
    }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} is invalid`)
    }
    return value as Record<string, unknown>
}

function requireText(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is invalid`)
    return value
}

function requireTextAllowEmpty(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new Error(`${label} is invalid`)
    return value
}
