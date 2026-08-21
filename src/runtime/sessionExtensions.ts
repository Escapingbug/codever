import {
    sessionExtensionDescriptorSchema,
    sessionExtensionViewSchema,
    type JsonValue,
    type SessionExtensionBinding,
    type SessionExtensionDescriptor,
    type SessionExtensionSummary,
    type SessionExtensionView,
} from '@codever/protocol'
import type { ConversationEvent, RichUserInput } from './semantic'

export type SessionExtensionLifecycleReason = 'archive' | 'delete' | 'replace' | 'shutdown'

export interface SessionExtensionContext {
    sessionId: string
    cwd: string
    providerName: string
    onLog?(message: string): void
}

export interface SessionExtensionTurnContext {
    sessionId: string
    turnId: string
    providerName: string
}

export interface SessionExtensionApproval {
    title: string
    details?: string
    approveLabel?: string
    denyLabel?: string
}

export interface ReadySessionExtensionTurn {
    kind: 'ready'
    input: string | RichUserInput
    stateRef?: string
}

export interface ApprovalRequiredSessionExtensionTurn {
    kind: 'approval_required'
    approval: SessionExtensionApproval
    approve(): Promise<ReadySessionExtensionTurn>
    reject?(): Promise<void>
}

export interface CancelledSessionExtensionTurn {
    kind: 'cancelled'
}

export interface InteractionRequiredSessionExtensionTurn {
    kind: 'interaction_required'
    view: SessionExtensionView
    cancelActionId: string
    respond(actionId: string): Promise<ReadySessionExtensionTurn | CancelledSessionExtensionTurn>
}

export type SessionExtensionTurnPreparation =
    | ReadySessionExtensionTurn
    | ApprovalRequiredSessionExtensionTurn
    | InteractionRequiredSessionExtensionTurn

export interface SessionExtensionInteractionRequest {
    extension: SessionExtensionSummary
    view: SessionExtensionView
    cancelActionId: string
}

export interface SessionExtensionInstance {
    readonly id: string
    readonly summary: SessionExtensionSummary
    prepareTurn(
        input: string | RichUserInput,
        context: SessionExtensionTurnContext,
    ): Promise<SessionExtensionTurnPreparation>
    presentEvent(
        event: ConversationEvent,
        context: SessionExtensionTurnContext,
        stateRef?: string,
    ): Promise<ConversationEvent[]>
    lifecycle(reason: SessionExtensionLifecycleReason): Promise<void>
}

export interface SessionExtensionProvider {
    readonly descriptor: SessionExtensionDescriptor
    normalizeConfig(config: Record<string, JsonValue> | undefined): Record<string, JsonValue>
    create(
        binding: SessionExtensionBinding,
        context: SessionExtensionContext,
    ): SessionExtensionInstance
}

export interface PreparedExtensionTurn {
    input: string | RichUserInput
    stateRefs: ReadonlyMap<string, string | undefined>
}

export class SessionExtensionRejectedError extends Error {
    constructor(readonly extensionId: string) {
        super(`Session extension ${extensionId} interaction was cancelled`)
        this.name = 'SessionExtensionRejectedError'
    }
}

export class SessionExtensionHost {
    constructor(private readonly extensions: readonly SessionExtensionInstance[] = []) {}

    get summaries(): SessionExtensionSummary[] {
        return this.extensions.map(extension => ({ ...extension.summary }))
    }

    get active(): boolean {
        return this.extensions.length > 0
    }

    async prepareTurn(
        input: string | RichUserInput,
        context: SessionExtensionTurnContext,
        requestInteraction: (request: SessionExtensionInteractionRequest) => Promise<string>,
    ): Promise<PreparedExtensionTurn> {
        let preparedInput = input
        const stateRefs = new Map<string, string | undefined>()
        for (const extension of this.extensions) {
            let prepared = await extension.prepareTurn(preparedInput, context)
            if (prepared.kind === 'approval_required') {
                const actionId = await requestInteraction({
                    extension: extension.summary,
                    view: {
                        version: 1,
                        title: prepared.approval.title,
                        elements: prepared.approval.details
                            ? [{ type: 'text', text: prepared.approval.details }]
                            : [],
                        actions: [
                            {
                                id: 'allow',
                                label: prepared.approval.approveLabel ?? 'Continue',
                                style: 'primary',
                            },
                            {
                                id: 'deny',
                                label: prepared.approval.denyLabel ?? 'Cancel',
                                style: 'secondary',
                            },
                        ],
                    },
                    cancelActionId: 'deny',
                })
                if (actionId !== 'allow') {
                    await prepared.reject?.()
                    throw new SessionExtensionRejectedError(extension.id)
                }
                prepared = await prepared.approve()
            }
            if (prepared.kind === 'interaction_required') {
                const interaction = prepared
                const view = sessionExtensionViewSchema.parse(interaction.view)
                if (!view.actions.some(action => action.id === interaction.cancelActionId)) {
                    throw new Error(`Session extension ${extension.id} returned an invalid cancel action`)
                }
                const actionId = await requestInteraction({
                    extension: extension.summary,
                    view,
                    cancelActionId: interaction.cancelActionId,
                })
                if (!view.actions.some(action => action.id === actionId)) {
                    throw new Error(`Session extension ${extension.id} received an invalid action`)
                }
                const result = await interaction.respond(actionId)
                if (result.kind === 'cancelled') {
                    throw new SessionExtensionRejectedError(extension.id)
                }
                prepared = result
            }
            preparedInput = prepared.input
            stateRefs.set(extension.id, prepared.stateRef)
        }
        return { input: preparedInput, stateRefs }
    }

    async presentEvent(
        event: ConversationEvent,
        context: SessionExtensionTurnContext,
        stateRefs: ReadonlyMap<string, string | undefined>,
    ): Promise<ConversationEvent[]> {
        let events = [event]
        for (const extension of [...this.extensions].reverse()) {
            const presented: ConversationEvent[] = []
            for (const current of events) {
                presented.push(...await extension.presentEvent(
                    current,
                    context,
                    stateRefs.get(extension.id),
                ))
            }
            events = presented
        }
        return events
    }

    async lifecycle(reason: SessionExtensionLifecycleReason): Promise<void> {
        const results = await Promise.allSettled(
            this.extensions.map(extension => extension.lifecycle(reason)),
        )
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure) throw failure.reason
    }
}

export class SessionExtensionRegistry {
    private readonly providers = new Map<string, SessionExtensionProvider>()

    constructor(providers: readonly SessionExtensionProvider[] = []) {
        for (const provider of providers) this.register(provider)
    }

    register(provider: SessionExtensionProvider): void {
        sessionExtensionDescriptorSchema.parse(provider.descriptor)
        if (this.providers.has(provider.descriptor.id)) {
            throw new Error(`Duplicate session extension ${provider.descriptor.id}`)
        }
        this.providers.set(provider.descriptor.id, provider)
    }

    descriptors(): SessionExtensionDescriptor[] {
        return [...this.providers.values()].map(provider => structuredClone(provider.descriptor))
    }

    normalizeBindings(bindings: readonly SessionExtensionBinding[] | undefined): SessionExtensionBinding[] {
        const seen = new Set<string>()
        return (bindings ?? []).map(binding => {
            if (seen.has(binding.id)) throw new Error(`Duplicate session extension ${binding.id}`)
            seen.add(binding.id)
            const provider = this.providers.get(binding.id)
            if (!provider) throw new Error(`Session extension ${binding.id} is not installed`)
            const config = provider.normalizeConfig(binding.config)
            return {
                id: binding.id,
                ...(Object.keys(config).length ? { config } : {}),
            }
        })
    }

    createInstances(
        bindings: readonly SessionExtensionBinding[],
        context: SessionExtensionContext,
    ): SessionExtensionInstance[] {
        return bindings.map(binding => {
            const provider = this.providers.get(binding.id)
            return provider
                ? provider.create(binding, context)
                : unavailableExtension(binding.id)
        })
    }

    summaries(bindings: readonly SessionExtensionBinding[]): SessionExtensionSummary[] {
        return bindings.map(binding => {
            const descriptor = this.providers.get(binding.id)?.descriptor
            return descriptor
                ? { id: descriptor.id, name: descriptor.name, version: descriptor.version }
                : { id: binding.id, name: binding.id, version: 'unavailable' }
        })
    }
}

export function normalizeDeclarativeExtensionConfig(
    descriptor: SessionExtensionDescriptor,
    config: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> {
    const supplied = config ?? {}
    const settings = new Map(descriptor.settings.map(setting => [setting.id, setting]))
    for (const key of Object.keys(supplied)) {
        if (!settings.has(key)) throw new Error(`Unknown ${descriptor.id} setting ${key}`)
    }

    const normalized: Record<string, JsonValue> = {}
    for (const setting of descriptor.settings) {
        const value = Object.hasOwn(supplied, setting.id)
            ? supplied[setting.id]
            : ('defaultValue' in setting ? setting.defaultValue : undefined)
        if (value === undefined) {
            if (setting.type === 'text' && setting.required) {
                throw new Error(`${descriptor.name} requires ${setting.label}`)
            }
            continue
        }
        if (setting.type === 'text') {
            if (typeof value !== 'string') throw new Error(`${setting.label} must be text`)
            const text = value.trim()
            if (setting.required && !text) throw new Error(`${descriptor.name} requires ${setting.label}`)
            if (text) normalized[setting.id] = text
            continue
        }
        if (typeof value !== 'boolean') throw new Error(`${setting.label} must be true or false`)
        normalized[setting.id] = value
    }
    return normalized
}

function unavailableExtension(id: string): SessionExtensionInstance {
    const error = () => new Error(`Session extension ${id} is unavailable; the turn was blocked`)
    return {
        id,
        summary: { id, name: id, version: 'unavailable' },
        prepareTurn: async () => { throw error() },
        presentEvent: async () => { throw error() },
        lifecycle: async () => {},
    }
}
