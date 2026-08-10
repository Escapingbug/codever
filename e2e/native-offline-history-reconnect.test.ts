import { describe, expect, it } from 'vitest'
import {
    NATIVE_BRIDGE_LIMITS,
    type BridgeMethodParams,
    type CapabilityName,
    type ClientEvent,
    type ClientMessage,
    type ClientSnapshot,
    type HelloResult,
    type RequestMethod,
} from '@codever/native-bridge'
import {
    NativeBridgeClient,
    OPTIONAL_NATIVE_CAPABILITIES,
    REQUIRED_NATIVE_CAPABILITIES,
    type NativeCursorStore,
} from '../apps/pwa/app/client/native/NativeBridgeClient'
import type { CollaborationState } from '../apps/pwa/app/client/CodeverClient'
import {
    acquireNativeRpcBridge,
    type NativeBridgePort,
} from '../apps/pwa/app/client/native/NativeRpcBridge'
import { shouldReconcileRecentHistory } from '../apps/pwa/app/crossDeviceSync'

describe('native offline history and reconnect', () => {
    it('opens cached history offline and replays missed events once after WebView restart', async () => {
        const port = new PersistentHistoryPort([
            message('history-1', 1, 'first cached reply', true),
            message('history-2', 2, 'second cached reply', true),
        ])
        const cursorValues = new Map<string, string>()
        const cursorStore: NativeCursorStore = {
            load: deviceId => cursorValues.get(deviceId),
            save: (deviceId, cursor) => cursorValues.set(deviceId, cursor),
        }

        port.phase = 'offline'
        const firstStatuses: string[] = []
        const first = await createClient(port, cursorStore, {
            onStatus: status => firstStatuses.push(status),
        })
        expect(firstStatuses).toContain('offline')
        await expect(first.loadRecentHistory('session-history', 30)).resolves.toEqual({
            messages: [
                message('history-1', 1, 'first cached reply', true),
                message('history-2', 2, 'second cached reply', true),
            ],
            hasMore: false,
        })
        first.dispose()

        // Matrix receives this encrypted event while no WebView owns the
        // bridge. The native journal must retain it for the next attachment.
        port.appendWhileDetached(message(
            'history-3',
            3,
            'reply received while the UI was gone',
            false,
        ))
        port.phase = 'ready'

        const replayed: string[] = []
        const secondStatuses: string[] = []
        const second = await createClient(port, cursorStore, {
            onStatus: status => secondStatuses.push(status),
            onMessage: incoming => replayed.push(incoming.eventId),
        })
        expect(port.lastSubscribeAfter).toBe('cursor-barrier-1')
        expect(secondStatuses).toContain('connected')
        expect(replayed).toEqual(['history-3'])
        await expect(second.loadRecentHistory('session-history', 30)).resolves.toEqual({
            messages: [
                message('history-1', 1, 'first cached reply', true),
                message('history-2', 2, 'second cached reply', true),
                message('history-3', 3, 'reply received while the UI was gone', false),
            ],
            hasMore: false,
        })

        port.deliverLive(message('history-4', 4, 'live after reconnect', false))
        await nextTurn()
        expect(replayed).toEqual(['history-3', 'history-4'])
        expect(new Set(replayed).size).toBe(replayed.length)
        expect(cursorValues.get('native-history-device')).toBe('cursor-live-4')
        expect(port.failures).toEqual([])
        second.dispose()
    })

    it('repairs output missed by the phone timeline when another device completes the session', async () => {
        const port = new PersistentHistoryPort([
            message('cross-device-user', 1, 'first message from the phone', false),
            message('cross-device-command', 2, 'running command', false),
        ])
        let client: NativeBridgeClient
        let previousUpdatedAt: number | undefined
        let resolveRecovery!: (messages: ClientMessage[]) => void
        const recovered = new Promise<ClientMessage[]>(resolve => {
            resolveRecovery = resolve
        })
        client = await createClient(port, { load: () => undefined, save() {} }, {
            onCollaborationState(state) {
                const session = state.gatewayState?.sessions.find(
                    candidate => candidate.id === 'session-history',
                )
                const nextUpdatedAt = session?.updatedAt
                if (shouldReconcileRecentHistory({
                    selectedSessionId: 'session-history',
                    previousUpdatedAt,
                    nextUpdatedAt,
                })) {
                    void client.loadRecentHistory('session-history', 30)
                        .then(page => resolveRecovery(page.messages))
                }
                previousUpdatedAt = nextUpdatedAt
            },
        })
        await expect(client.loadRecentHistory('session-history', 30)).resolves.toMatchObject({
            messages: [
                { eventId: 'cross-device-user' },
                { eventId: 'cross-device-command' },
            ],
        })
        port.deliverGatewayState(1)
        await nextTurn()

        // The ordinary Matrix timeline event is deliberately absent. Only the
        // authoritative Gateway state advances, exactly like a limited native
        // sync that retained the running command but dropped the final answer.
        port.appendWithoutTimeline(
            message('cross-device-final', 3, 'final answer from the browser task', true),
        )
        port.deliverGatewayState(2)

        await expect(within(recovered, 5_000)).resolves.toEqual([
            expect.objectContaining({ eventId: 'cross-device-user' }),
            expect.objectContaining({ eventId: 'cross-device-command' }),
            expect.objectContaining({ eventId: 'cross-device-final' }),
        ])
        expect(port.failures).toEqual([])
        client.dispose()
    })
})

type Handlers = {
    onStatus?(status: string): void
    onMessage?(message: ClientMessage): void
    onCollaborationState?(state: CollaborationState): void
}

type RpcRequest = {
    jsonrpc: '2.0'
    id: string
    method: RequestMethod
    params: BridgeMethodParams[RequestMethod]
}

class PersistentHistoryPort implements NativeBridgePort {
    onmessage: NativeBridgePort['onmessage'] = null
    phase: ClientSnapshot['lifecycle']['phase'] = 'offline'
    lastSubscribeAfter: string | undefined
    readonly failures: string[] = []
    private readonly history: ClientMessage[]
    private replay: ClientEvent[] = []
    private subscriptionId = 'subscription-history-1'

    constructor(initialHistory: ClientMessage[]) {
        this.history = [...initialHistory]
    }

    postMessage(messageJson: string): void {
        const request = JSON.parse(messageJson) as RpcRequest
        try {
            this.respond(request)
        } catch (error) {
            this.failures.push(error instanceof Error ? error.message : String(error))
        }
    }

    appendWhileDetached(incoming: ClientMessage): void {
        this.history.push(incoming)
        this.replay.push(messageEvent(incoming, 'cursor-detached-3'))
    }

    appendWithoutTimeline(incoming: ClientMessage): void {
        this.history.push(incoming)
    }

    deliverGatewayState(updatedAt: number): void {
        this.deliver([{
            schemaVersion: 1,
            eventId: `bridge-gateway-state-${updatedAt}`,
            cursor: `cursor-gateway-state-${updatedAt}`,
            occurredAt: updatedAt,
            type: 'gateway.state.changed',
            payload: gatewayState(updatedAt),
        }])
    }

    deliverLive(incoming: ClientMessage): void {
        this.history.push(incoming)
        this.deliver([messageEvent(incoming, 'cursor-live-4')])
    }

    private respond(request: RpcRequest): void {
        switch (request.method) {
            case 'codever.bridge.hello':
                this.result(request, helloResult())
                return
            case 'codever.client.start':
                this.result(request, {
                    deviceId: 'native-history-device',
                    snapshot: snapshot(this.phase),
                })
                return
            case 'codever.events.subscribe': {
                this.lastSubscribeAfter = request.params.afterCursor
                this.subscriptionId = `subscription-history-${this.phase}`
                const events = this.replay
                this.replay = []
                this.result(request, {
                    subscriptionId: this.subscriptionId,
                    barrierCursor: events.at(-1)?.cursor ?? 'cursor-barrier-1',
                    mode: 'replay',
                    events,
                })
                return
            }
            case 'codever.events.activate':
            case 'codever.events.ack':
                this.result(request, {
                    subscriptionId: this.subscriptionId,
                    throughCursor: request.params.throughCursor,
                })
                return
            case 'codever.events.unsubscribe':
                this.result(request, {
                    subscriptionId: request.params.subscriptionId,
                    unsubscribed: true,
                })
                return
            case 'codever.history.page':
                this.result(request, {
                    sessionId: request.params.sessionId,
                    messages: this.history.slice(-request.params.limit),
                    hasMore: false,
                    asOfCursor: this.history.at(-1)?.eventId ?? 'history-empty',
                })
                return
            default:
                throw new Error(`Unexpected history E2E method: ${request.method}`)
        }
    }

    private deliver(events: ClientEvent[]): void {
        this.onmessage?.({
            data: JSON.stringify({
                jsonrpc: '2.0',
                method: 'codever.events.deliver',
                params: { subscriptionId: this.subscriptionId, events },
            }),
        })
    }

    private result(request: RpcRequest, result: unknown): void {
        this.onmessage?.({
            data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
        })
    }
}

async function createClient(
    port: PersistentHistoryPort,
    cursorStore: NativeCursorStore,
    handlers: Handlers,
): Promise<NativeBridgeClient> {
    const bridge = await acquireNativeRpcBridge(port)
    const hello = await bridge.hello({
        webBuild: 'native-history-e2e',
        requiredCapabilities: [],
        optionalCapabilities: [
            ...REQUIRED_NATIVE_CAPABILITIES,
            ...OPTIONAL_NATIVE_CAPABILITIES,
        ].map(name => ({ name, versions: [1] })),
    })
    const client = new NativeBridgeClient(bridge, hello, {
        onMessage: incoming => handlers.onMessage?.(incoming),
        onStatus: status => handlers.onStatus?.(status),
        onCollaborationState: state => handlers.onCollaborationState?.(state),
    }, cursorStore)
    await client.ready
    return client
}

function message(
    eventId: string,
    timestamp: number,
    text: string,
    historical: boolean,
): ClientMessage {
    return {
        eventId,
        sender: 'gateway-1',
        timestamp,
        encrypted: true,
        kind: 'agent',
        text,
        sessionId: 'session-history',
        historical,
        format: 'markdown',
    }
}

function messageEvent(incoming: ClientMessage, cursor: string): ClientEvent {
    return {
        schemaVersion: 1,
        eventId: `bridge-${incoming.eventId}`,
        cursor,
        occurredAt: incoming.timestamp,
        type: 'message.upserted',
        payload: incoming,
    }
}

function helloResult(): HelloResult {
    const capabilities = Object.fromEntries(
        [...REQUIRED_NATIVE_CAPABILITIES, ...OPTIONAL_NATIVE_CAPABILITIES]
            .map(name => [name, { version: 1 }]),
    ) as Record<CapabilityName, { version: number }>
    return {
        protocolVersion: 1,
        bridgeSessionId: 'bridge-session-history-e2e',
        native: {
            runtimeVersion: '0.1.0',
            runtimeBuild: 'android-history-e2e',
            platform: 'android',
        },
        capabilities,
        limits: NATIVE_BRIDGE_LIMITS,
    }
}

function snapshot(phase: ClientSnapshot['lifecycle']['phase']): ClientSnapshot {
    return {
        schemaVersion: 1,
        deviceId: 'native-history-device',
        cursor: 'cursor-snapshot-history',
        generatedAt: 1,
        lifecycle: { phase, since: 1 },
        foregroundService: {
            required: true,
            active: true,
            notificationVisible: true,
        },
        trust: { state: 'unpaired' },
        commands: [],
    }
}

function gatewayState(updatedAt: number): Record<string, unknown> {
    return {
        kind: 'gateway_state',
        version: 1,
        state_version: updatedAt,
        revision: updatedAt,
        revision_epoch: 'runtime-epoch-1',
        revision_epoch_generation: 1,
        active_device_count: 2,
        current_session_id: 'session-history',
        sessions: [{
            id: 'session-history',
            title: 'Cross-device session',
            updated_at: updatedAt,
            status: 'idle',
            project_id: 'project-codever',
            project_name: 'codever',
            cwd: '/workspace/codever',
            provider: 'codex',
            extensions: [],
        }],
        workspace: {
            project_id: 'project-codever',
            project_name: 'codever',
            cwd: '/workspace/codever',
            provider: 'codex',
            permission_mode: 'default',
        },
        capabilities: {
            models: [],
            permission_modes: [],
            can_create_session: true,
            can_select_session: true,
            session_extensions: [],
        },
    }
}

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(
            () => reject(new Error(`Timed out after ${timeoutMs} ms.`)),
            timeoutMs,
        )),
    ])
}

function nextTurn(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}
