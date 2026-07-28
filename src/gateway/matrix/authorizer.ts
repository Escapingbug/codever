import { signedCommandSchema, type CodeverCommand, type SignedCommand } from '@codever/protocol'
import { ReplayGuard, verifyCommand } from '@codever/security'
import type { MatrixGatewayTrustedDevice } from './config'
import type { FileCommandReplayStore } from './fileReplayLedger'

export interface MatrixCommandContext {
    roomId: string
    conversationId: string
    matrixSender: string
    matrixDeviceKey: string
}

export class StrictMatrixCommandAuthorizer {
    private readonly devices = new Map<string, MatrixGatewayTrustedDevice>()
    private readonly replayGuard: ReplayGuard

    constructor(
        private readonly gatewayId: string,
        trustedDevices: MatrixGatewayTrustedDevice[],
        private readonly replayStore: FileCommandReplayStore,
    ) {
        for (const device of trustedDevices) this.devices.set(device.deviceId, device)
        this.replayGuard = new ReplayGuard(replayStore)
    }

    initialize(now = Date.now()): Promise<void> {
        return this.replayStore.initialize(now)
    }

    async authorize(input: unknown, context: MatrixCommandContext, now = Date.now()): Promise<CodeverCommand> {
        const signed = signedCommandSchema.parse(input) as SignedCommand
        const policy = this.devices.get(signed.command.deviceId)
        if (!policy) throw new MatrixAuthorizationError('untrusted-device', 'Codever device is not locally trusted')
        if (!policy.allowedRoomIds.includes(context.roomId)) {
            throw new MatrixAuthorizationError('room-not-allowed', 'Codever device is not allowed in this room')
        }
        if (policy.matrixUserId !== context.matrixSender) {
            throw new MatrixAuthorizationError('matrix-sender-mismatch', 'Matrix sender does not match the local device policy')
        }
        if (!policy.matrixDeviceKeys.includes(context.matrixDeviceKey)) {
            throw new MatrixAuthorizationError('matrix-device-mismatch', 'Matrix cryptographic device key is not locally pinned')
        }

        const command = await verifyCommand(signed, policy.publicKey, {
            gatewayId: this.gatewayId,
            deviceId: policy.deviceId,
            conversationId: context.conversationId,
            allowedOperations: policy.allowedOperations,
        }, { now })
        await this.replayGuard.claim(command, now)
        return command
    }
}

export type MatrixAuthorizationErrorCode =
    | 'untrusted-device'
    | 'room-not-allowed'
    | 'matrix-sender-mismatch'
    | 'matrix-device-mismatch'

export class MatrixAuthorizationError extends Error {
    constructor(
        readonly code: MatrixAuthorizationErrorCode,
        message: string,
    ) {
        super(message)
        this.name = 'MatrixAuthorizationError'
    }
}
