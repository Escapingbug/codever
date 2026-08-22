import { describe, expect, it, vi } from 'vitest'
import type {
    JsonValue,
    SessionExtensionBinding,
    SessionExtensionDescriptor,
} from '@codever/protocol'
import type { ConversationEvent } from '@/runtime/semantic'
import { HttpSessionExtensionProvider } from '@/runtime/httpSessionExtension'
import { createSessionExtensionRegistryFromEnvironment } from '@/runtime/sessionExtensionConfig'
import {
    normalizeDeclarativeExtensionConfig,
    SessionExtensionHost,
    SessionExtensionRegistry,
    type SessionExtensionContext,
    type SessionExtensionInstance,
    type SessionExtensionProvider,
} from '@/runtime/sessionExtensions'

const descriptor: SessionExtensionDescriptor = {
    id: 'test-extension',
    name: 'Test extension',
    description: 'Test-only transform',
    version: '1',
    settings: [
        { id: 'context', type: 'text', label: 'Context', required: true },
        { id: 'review', type: 'boolean', label: 'Review', defaultValue: true },
    ],
}

const context = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    providerName: 'test-provider',
}

function event(text: string): ConversationEvent {
    return {
        kind: 'assistant_text_delta',
        text,
        messageId: 'assistant-1',
        meta: {
            id: 'event-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            provider: 'test-provider',
            seq: 1,
            timestamp: 1,
            sourcePhase: 'live',
        },
    }
}

describe('session extension host', () => {
    it('is an exact pass-through for ordinary sessions', async () => {
        const host = new SessionExtensionHost()
        const prepared = await host.prepareTurn('ordinary prompt', context, async () => 'unused')
        const canonical = event('ordinary response')

        expect(prepared.input).toBe('ordinary prompt')
        expect(prepared.stateRefs.size).toBe(0)
        expect(await host.presentEvent(canonical, context, prepared.stateRefs)).toEqual([canonical])
    })

    it('commits approval before returning transformed provider input', async () => {
        const approve = vi.fn(async () => ({
            kind: 'ready' as const,
            input: 'sanitized prompt',
            stateRef: 'mapping-v1',
        }))
        const reject = vi.fn(async () => undefined)
        const extension: SessionExtensionInstance = {
            id: descriptor.id,
            summary: { id: descriptor.id, name: descriptor.name, version: descriptor.version },
            prepareTurn: async () => ({
                kind: 'approval_required',
                approval: { title: 'Review exact outbound text' },
                approve,
                reject,
            }),
            presentEvent: async value => value.kind === 'assistant_text_delta'
                ? [{ ...value, text: value.text.replace('Alias', 'Original') }]
                : [value],
            lifecycle: async () => undefined,
        }
        const host = new SessionExtensionHost([extension])
        const prepared = await host.prepareTurn('original prompt', context, async interaction => {
            expect(interaction.view.title).toBe('Review exact outbound text')
            return 'allow'
        })

        expect(prepared.input).toBe('sanitized prompt')
        expect(prepared.stateRefs.get(descriptor.id)).toBe('mapping-v1')
        expect(approve).toHaveBeenCalledOnce()
        expect(reject).not.toHaveBeenCalled()
        expect(await host.presentEvent(event('Hello Alias'), context, prepared.stateRefs))
            .toMatchObject([{ text: 'Hello Original' }])
    })

    it('unwraps provider events in reverse extension order', async () => {
        const extension = (id: string): SessionExtensionInstance => ({
            id,
            summary: { id, name: id, version: '1' },
            prepareTurn: async input => ({ kind: 'ready', input: `${String(input)}${id}` }),
            presentEvent: async value => value.kind === 'assistant_text_delta'
                ? [{ ...value, text: value.text.replace(id, '') }]
                : [value],
            lifecycle: async () => undefined,
        })
        const host = new SessionExtensionHost([extension('A'), extension('B')])
        const prepared = await host.prepareTurn('prompt', context, async () => 'unused')

        expect(prepared.input).toBe('promptAB')
        expect(await host.presentEvent(event('responseAB'), context, prepared.stateRefs))
            .toMatchObject([{ text: 'response' }])
    })
})

describe('session extension registry', () => {
    it('validates only installed declarative bindings and restores unavailable sessions fail-closed', async () => {
        const provider: SessionExtensionProvider = {
            descriptor,
            normalizeConfig: config => normalizeDeclarativeExtensionConfig(descriptor, config),
            create: (binding: SessionExtensionBinding, _context: SessionExtensionContext) => ({
                id: binding.id,
                summary: { id: binding.id, name: descriptor.name, version: descriptor.version },
                prepareTurn: async input => ({ kind: 'ready', input }),
                presentEvent: async value => [value],
                lifecycle: async () => undefined,
            }),
        }
        const registry = new SessionExtensionRegistry([provider])
        expect(registry.normalizeBindings([{
            id: descriptor.id,
            config: { context: ' app-1 ' },
        }])).toEqual([{
            id: descriptor.id,
            config: { context: 'app-1', review: true },
        }])
        expect(() => registry.normalizeBindings([{ id: 'missing' }])).toThrow('is not installed')
        expect(() => registry.normalizeBindings([
            { id: descriptor.id, config: { context: 'one' } },
            { id: descriptor.id, config: { context: 'two' } },
        ])).toThrow('Duplicate')

        const unavailable = new SessionExtensionRegistry().createInstances(
            [{ id: 'removed-extension' }],
            { sessionId: 'session-1', cwd: '/repo', providerName: 'test' },
        )[0]!
        await expect(unavailable.prepareTurn('plaintext', context)).rejects.toThrow('blocked')
    })

    it('discovers manifests only from administrator-owned loopback registrations', async () => {
        const registration = JSON.stringify([{
            endpoint: 'http://127.0.0.1:8791',
            bearerToken: 'extension-secret-at-least-32-bytes',
            expectedExtensionId: descriptor.id,
        }])
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            protocolVersion: 1,
            descriptor,
        }), { status: 200 }))
        vi.stubGlobal('fetch', fetchImpl)
        await expect(createSessionExtensionRegistryFromEnvironment({
            CODEVER_SESSION_EXTENSIONS_JSON: registration,
        })).resolves.toMatchObject({})
        const registry = await createSessionExtensionRegistryFromEnvironment({
            CODEVER_SESSION_EXTENSIONS_JSON: registration,
        })
        expect(registry.descriptors()).toEqual([descriptor])
        await expect(createSessionExtensionRegistryFromEnvironment({
            CODEVER_SESSION_EXTENSIONS_JSON: JSON.stringify([{
                endpoint: 'https://remote.example',
                bearerToken: 'extension-secret-at-least-32-bytes',
            }]),
        })).rejects.toThrow('loopback')
        vi.unstubAllGlobals()
    })

    it('rejects unknown, missing, and mistyped declarative settings', () => {
        const normalize = (config: Record<string, JsonValue>) =>
            normalizeDeclarativeExtensionConfig(descriptor, config)
        expect(() => normalize({ context: '' })).toThrow('requires Context')
        expect(() => normalize({ context: 'one', extra: true })).toThrow('Unknown')
        expect(() => normalize({ context: 'one', review: 'yes' })).toThrow('true or false')
        expect(() => normalize({ context: 'one', review: null })).toThrow('true or false')
    })
})

describe('HTTP session extension boundary', () => {
    it('uses the preview/commit protocol and strips provider raw metadata', async () => {
        const requests: Array<{ path: string; body: Record<string, unknown> }> = []
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(url)).pathname
            if (path === '/v1/manifest') {
                return new Response(JSON.stringify({
                    protocolVersion: 1,
                    descriptor,
                }), { status: 200 })
            }
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>
            requests.push({ path, body })
            if (path === '/v1/turns/prepare') {
                return new Response(JSON.stringify({
                    kind: 'interaction_required',
                    preparationToken: 'preview-1',
                    cancelActionId: 'cancel',
                    view: {
                        version: 1,
                        title: 'Review transformed input',
                        elements: [{
                            type: 'readonly_textarea',
                            label: 'Agent input',
                            value: 'PREFIX: private',
                        }],
                        actions: [
                            { id: 'continue', label: 'Continue', style: 'primary' },
                            { id: 'cancel', label: 'Cancel', style: 'secondary' },
                        ],
                    },
                }), { status: 200 })
            }
            if (path === '/v1/interactions/respond') {
                return new Response(JSON.stringify({
                    kind: 'ready',
                    input: 'PREFIX: private',
                    stateRef: 'transform-1',
                }), { status: 200 })
            }
            if (path === '/v1/events/present') {
                const incoming = body.event as Record<string, unknown>
                return new Response(JSON.stringify({ events: [incoming] }), { status: 200 })
            }
            return new Response(JSON.stringify({ handled: true }), { status: 200 })
        }) as typeof fetch
        const provider = await HttpSessionExtensionProvider.connect({
            endpoint: 'http://127.0.0.1:8791',
            bearerToken: 'extension-secret-at-least-32-bytes',
            expectedExtensionId: descriptor.id,
            fetch: fetchImpl,
        })
        const instance = provider.create({
            id: descriptor.id,
            config: { context: 'app-1' },
        }, {
            sessionId: 'session-1',
            cwd: '/repo',
            providerName: 'test-provider',
        })
        const preparation = await instance.prepareTurn('private', context)
        expect(preparation.kind).toBe('interaction_required')
        if (preparation.kind !== 'interaction_required') throw new Error('expected interaction')
        await expect(preparation.respond('continue')).resolves.toEqual({
            kind: 'ready',
            input: 'PREFIX: private',
            stateRef: 'transform-1',
        })
        const canonical = event('sanitized response')
        canonical.meta.raw = { secretProviderEnvelope: true }
        await expect(instance.presentEvent(canonical, context, 'transform-1'))
            .resolves.toMatchObject([{ text: 'sanitized response' }])
        await expect(instance.presentEvent({
            kind: 'provider_raw',
            meta: canonical.meta,
            providerEvent: {
                kind: 'raw',
                providerName: 'test-provider',
                rawMessage: { secretProviderEnvelope: true },
            },
        }, context, 'transform-1')).resolves.toEqual([])

        expect(requests.map(request => request.path)).toEqual([
            '/v1/turns/prepare',
            '/v1/interactions/respond',
            '/v1/events/present',
        ])
        const publicEvent = requests[2]?.body.event as ConversationEvent
        expect(publicEvent.meta).not.toHaveProperty('raw')
    })
})
