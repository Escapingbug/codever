import {
    signedCommandSchema,
    type CodeverCommand,
    type SignedCommand,
} from '@codever/protocol'
import {
    ReplayGuard,
    verifyCommand,
} from '@codever/security'
import type { SessionInput } from '@/runtime/semantic'
import type { MatrixIncomingEvent } from './transport'

export interface TrustedCodeverDeviceStore {
    getPublicKey(deviceId: string, keyId: string): Promise<CryptoKey | JsonWebKey | null>
}

export class InMemoryTrustedCodeverDeviceStore implements TrustedCodeverDeviceStore {
    private readonly keys = new Map<string, CryptoKey | JsonWebKey>()

    pin(deviceId: string, keyId: string, publicKey: CryptoKey | JsonWebKey): void {
        this.keys.set(deviceKey(deviceId, keyId), publicKey)
    }

    unpin(deviceId: string, keyId: string): boolean {
        return this.keys.delete(deviceKey(deviceId, keyId))
    }

    async getPublicKey(deviceId: string, keyId: string): Promise<CryptoKey | JsonWebKey | null> {
        return this.keys.get(deviceKey(deviceId, keyId)) ?? null
    }
}

export interface StrictMatrixCommandAuthorizerOptions {
    gatewayId: string
    trustedDevices: TrustedCodeverDeviceStore
    replayGuard: ReplayGuard
    resolveConversationId?: (roomId: string) => string
    now?: () => number
}

/**
 * Builds the strict-mode callback consumed by MatrixIncomingRouter.
 *
 * Matrix room IDs, membership and power levels are deliberately not accepted
 * as authorization. The signed command is bound to the gateway, Codever device
 * and logical conversation, then claimed by the replay guard before it is
 * converted into runtime input.
 */
export function createStrictMatrixCommandAuthorizer(
    options: StrictMatrixCommandAuthorizerOptions,
): (envelope: unknown, event: MatrixIncomingEvent) => Promise<readonly SessionInput[]> {
    return async (envelope, event) => {
        const signed = signedCommandSchema.parse(envelope) as SignedCommand
        const publicKey = await options.trustedDevices.getPublicKey(
            signed.command.deviceId,
            signed.signature.keyId,
        )
        if (!publicKey) throw new Error('Codever device key is not locally pinned')

        const command = await verifyCommand(
            signed,
            publicKey,
            {
                gatewayId: options.gatewayId,
                deviceId: signed.command.deviceId,
                conversationId: options.resolveConversationId?.(event.roomId) ?? event.roomId,
            },
            { now: options.now?.() },
        )
        await options.replayGuard.claim(command, options.now?.())
        return commandToSessionInputs(command, event.sender)
    }
}

function commandToSessionInputs(command: CodeverCommand, sender: string): readonly SessionInput[] {
    const user = {
        id: command.deviceId,
        username: sender,
        displayName: sender,
    }
    switch (command.payload.operation) {
        case 'prompt':
            if (command.payload.attachments?.length) {
                throw new Error('Encrypted attachment materialization is not available yet')
            }
            return [{
                kind: 'user_message',
                text: command.payload.text,
                source: 'channel',
                user,
            }]
        case 'cancel':
            return [{ kind: 'cancel', reason: 'user', source: 'channel', user }]
        case 'decision':
            return [{
                kind: 'decision_response',
                decisionId: command.payload.requestId,
                value: command.payload.decision,
                source: 'channel',
                user,
            }]
        case 'session.settings': {
            const inputs: SessionInput[] = []
            if (command.payload.cwd !== undefined) {
                inputs.push({ kind: 'command', name: 'cwd', args: command.payload.cwd, source: 'channel', user })
            }
            if (command.payload.provider !== undefined) {
                inputs.push({ kind: 'command', name: 'provider', args: command.payload.provider, source: 'channel', user })
            }
            if (command.payload.model !== undefined) {
                inputs.push({ kind: 'command', name: 'model', args: command.payload.model, source: 'channel', user })
            }
            if (command.payload.permissionMode !== undefined) {
                inputs.push({
                    kind: 'command',
                    name: 'permissionMode',
                    args: command.payload.permissionMode,
                    source: 'channel',
                    user,
                })
            }
            return inputs
        }
        case 'session.create':
            return [{ kind: 'command', name: 'new', source: 'channel', user }]
    }
}

function deviceKey(deviceId: string, keyId: string): string {
    return `${deviceId}\0${keyId}`
}
