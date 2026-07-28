import { signedCommandSchema, type CodeverCommand, type SignedCommand } from '@codever/protocol'
import { SecurityError, verifyCommand } from '@codever/security'
import type { MatrixGatewayTrustedDevice } from './config'
import type { FileCommandReplayStore } from './fileReplayLedger'

export interface MatrixCommandContext {
    roomId: string
    conversationId: string
    matrixSender: string
    matrixDeviceKey: string
    applicationDeviceId?: string
}

export class StrictMatrixCommandAuthorizer {
    private readonly devices = new Map<string, MatrixGatewayTrustedDevice>()

    constructor(
        private readonly gatewayId: string,
        trustedDevices: MatrixGatewayTrustedDevice[],
        private readonly replayStore: FileCommandReplayStore,
        private readonly sequenceEpoch = 'legacy-v1',
    ) {
        for (const device of trustedDevices) this.devices.set(device.deviceId, device)
    }

    initialize(now = Date.now()): Promise<void> {
        return this.replayStore.initialize(now)
    }

    trustDevice(device: MatrixGatewayTrustedDevice): void {
        this.devices.set(device.deviceId, device)
    }

    async authorize(input: unknown, context: MatrixCommandContext, now = Date.now()): Promise<CodeverCommand> {
        const result = await this.authorizeDelivery(input, context, now)
        if (result.duplicate) {
            throw new SecurityError('replay', 'Command nonce or command id has already been used')
        }
        return result.command
    }

    async authorizeDelivery(
        input: unknown,
        context: MatrixCommandContext,
        now = Date.now(),
    ): Promise<{ command: CodeverCommand; duplicate: boolean; revision: number }> {
        const signed = signedCommandSchema.parse(input) as SignedCommand
        const policy = this.devices.get(signed.command.deviceId)
        if (!policy) throw new MatrixAuthorizationError('untrusted-device', 'Codever device is not locally trusted')
        if (!policy.allowedRoomIds.includes(context.roomId)) {
            throw new MatrixAuthorizationError('room-not-allowed', 'Codever device is not allowed in this room')
        }
        if (context.applicationDeviceId !== undefined && context.applicationDeviceId !== policy.deviceId) {
            throw new MatrixAuthorizationError('application-device-mismatch', 'Application-layer sender does not match the command device')
        }
        if (context.applicationDeviceId === undefined && policy.matrixUserId !== context.matrixSender) {
            throw new MatrixAuthorizationError('matrix-sender-mismatch', 'Matrix sender does not match the local device policy')
        }
        if (context.applicationDeviceId === undefined && !policy.matrixDeviceKeys.includes(context.matrixDeviceKey)) {
            throw new MatrixAuthorizationError('matrix-device-mismatch', 'Matrix cryptographic device key is not locally pinned')
        }
        if (policy.certificateExpiresAt !== undefined && policy.certificateExpiresAt <= now) {
            throw new MatrixAuthorizationError('certificate-expired', 'Pairing certificate has expired')
        }

        const command = await verifyCommand(signed, policy.publicKey, {
            gatewayId: this.gatewayId,
            deviceId: policy.deviceId,
            conversationId: context.conversationId,
            allowedOperations: policy.allowedOperations,
        }, { now })
        const claim = await this.replayStore.claimCommandInOrder(
            command,
            now,
            policy.sequenceEpoch ?? this.sequenceEpoch,
        )
        return { command, duplicate: claim.status === 'duplicate', revision: claim.revision }
    }
}

export type MatrixAuthorizationErrorCode =
    | 'untrusted-device'
    | 'room-not-allowed'
    | 'matrix-sender-mismatch'
    | 'matrix-device-mismatch'
    | 'application-device-mismatch'
    | 'certificate-expired'

export class MatrixAuthorizationError extends Error {
    constructor(
        readonly code: MatrixAuthorizationErrorCode,
        message: string,
    ) {
        super(message)
        this.name = 'MatrixAuthorizationError'
    }
}
