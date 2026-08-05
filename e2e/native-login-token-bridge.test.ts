import { describe, expect, it } from 'vitest'
import {
    NATIVE_BRIDGE_LIMITS,
    parseRpcRequest,
    type HelloResult,
} from '@codever/native-bridge'
import {
    NativeRpcBridge,
    type NativeBridgePort,
} from '../apps/pwa/app/client/native/NativeRpcBridge'

class NativeLoginTokenPort implements NativeBridgePort {
    onmessage: NativeBridgePort['onmessage'] = null
    readonly requests: unknown[] = []

    postMessage(message: string): void {
        const request = parseRpcRequest(JSON.parse(message))
        this.requests.push(request)
        const result = request.method === 'codever.bridge.hello'
            ? helloResult()
            : request.method === 'codever.matrix.loginToken'
                ? {
                    status: 'ready',
                    loginToken: 'single-use-token',
                    expiresAt: 120_000,
                }
                : undefined
        queueMicrotask(() => this.onmessage?.({
            data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
        }))
    }
}

describe('native-owned device invitation credential', () => {
    it('negotiates and issues a one-time Matrix token bound to the invitation command', async () => {
        const port = new NativeLoginTokenPort()
        const bridge = new NativeRpcBridge(port)
        const hello = await bridge.hello({
            webBuild: 'e2e-build',
            requiredCapabilities: [],
            optionalCapabilities: [{ name: 'matrix.login-token', versions: [1] }],
        })

        expect(hello.capabilities['matrix.login-token']?.version).toBe(1)
        const result = await bridge.request('codever.matrix.loginToken', {
            context: bridge.context(),
            idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
            invitationId: 'device-invite-command-1',
        })

        expect(result).toEqual({
            status: 'ready',
            loginToken: 'single-use-token',
            expiresAt: 120_000,
        })
        expect(port.requests.at(-1)).toMatchObject({
            method: 'codever.matrix.loginToken',
            params: {
                invitationId: 'device-invite-command-1',
                context: { bridgeSessionId: 'bridge-e2e-session' },
            },
        })
        bridge.close()
    })
})

function helloResult(): HelloResult {
    return {
        protocolVersion: 1,
        bridgeSessionId: 'bridge-e2e-session',
        native: {
            runtimeVersion: '0.1.0',
            runtimeBuild: 'android-e2e',
            platform: 'android',
        },
        capabilities: { 'matrix.login-token': { version: 1 } },
        limits: NATIVE_BRIDGE_LIMITS,
    }
}
