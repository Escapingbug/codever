import type { CommandOperation } from '@codever/protocol'

export interface MatrixGatewayCryptoConfig {
    /**
     * Production gateways must persist the Rust crypto store. In-memory crypto
     * is available only when explicitly enabled for tests.
     */
    useIndexedDB: boolean
    databasePrefix: string
    storageKey?: Uint8Array
    storagePassword?: string
    allowInMemoryForTesting?: boolean
}

export interface MatrixGatewayConnectionConfig {
    baseUrl: string
    accessToken: string
    userId: string
    deviceId: string
    initialSyncTimeoutMs?: number
}

export interface MatrixGatewayRoomConfig {
    roomId: string
    /** Stable Codever conversation binding, distinct from an ACP session ID. */
    conversationId: string
    cwd: string
    providerName: string
    model?: string
    verboseLevel?: 0 | 1 | 2
    timeoutSeconds?: number
    providerSettings?: Record<string, unknown>
}

export interface MatrixGatewayTrustedDevice {
    /** Codever application-layer device ID carried inside the signed command. */
    deviceId: string
    publicKey: JsonWebKey
    allowedRoomIds: string[]
    allowedOperations?: CommandOperation[]
    /** Defense in depth; these Matrix assertions never replace app signatures. */
    matrixUserId: string
    /** Matrix device ID used only to locate the device whose key is pinned. */
    matrixDeviceId?: string
    /**
     * Raw Ed25519 fingerprints returned by
     * MatrixEvent.getClaimedEd25519Key() after E2EE decryption. These are not
     * Matrix device IDs and not Curve25519 sender keys.
     */
    matrixDeviceKeys: string[]
}

export interface MatrixGatewayConfig {
    gatewayId: string
    connection: MatrixGatewayConnectionConfig
    crypto: MatrixGatewayCryptoConfig
    rooms: MatrixGatewayRoomConfig[]
    trustedDevices: MatrixGatewayTrustedDevice[]
    replayLedgerPath: string
    startupEventQueueLimit?: number
}

export function validateMatrixGatewayConfig(config: MatrixGatewayConfig): void {
    requireText(config.gatewayId, 'gatewayId')
    requireText(config.connection.baseUrl, 'connection.baseUrl')
    requireText(config.connection.accessToken, 'connection.accessToken')
    requireText(config.connection.userId, 'connection.userId')
    requireText(config.connection.deviceId, 'connection.deviceId')
    requireText(config.crypto.databasePrefix, 'crypto.databasePrefix')
    requireText(config.replayLedgerPath, 'replayLedgerPath')

    if (!config.crypto.useIndexedDB && !config.crypto.allowInMemoryForTesting) {
        throw new Error('In-memory Matrix crypto is forbidden unless allowInMemoryForTesting is explicitly enabled')
    }
    if (config.crypto.storageKey && config.crypto.storageKey.byteLength !== 32) {
        throw new Error('Matrix crypto storageKey must be exactly 32 bytes')
    }
    if (config.rooms.length === 0) throw new Error('At least one Matrix room is required')
    if (config.trustedDevices.length === 0) throw new Error('At least one locally trusted Codever device is required')

    assertUnique(config.rooms.map(room => room.roomId), 'room ID')
    assertUnique(config.rooms.map(room => room.conversationId), 'conversation ID')
    assertUnique(config.trustedDevices.map(device => device.deviceId), 'trusted device ID')

    const roomIds = new Set(config.rooms.map(room => room.roomId))
    for (const room of config.rooms) {
        requireText(room.roomId, 'room.roomId')
        requireText(room.conversationId, 'room.conversationId')
        requireText(room.cwd, 'room.cwd')
        requireText(room.providerName, 'room.providerName')
    }
    for (const device of config.trustedDevices) {
        requireText(device.deviceId, 'trustedDevice.deviceId')
        requireText(device.matrixUserId, 'trustedDevice.matrixUserId')
        if (device.matrixDeviceId !== undefined) {
            requireText(device.matrixDeviceId, 'trustedDevice.matrixDeviceId')
        }
        if (device.matrixDeviceKeys.length === 0) {
            throw new Error(`Trusted device ${device.deviceId} must pin at least one Matrix device key`)
        }
        for (const roomId of device.allowedRoomIds) {
            if (!roomIds.has(roomId)) {
                throw new Error(`Trusted device ${device.deviceId} references unknown room ${roomId}`)
            }
        }
    }

    if (config.startupEventQueueLimit !== undefined && config.startupEventQueueLimit < 1) {
        throw new Error('startupEventQueueLimit must be at least 1')
    }
}

function requireText(value: string, name: string): void {
    if (!value.trim()) throw new Error(`${name} must not be empty`)
}

function assertUnique(values: string[], label: string): void {
    const seen = new Set<string>()
    for (const value of values) {
        if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`)
        seen.add(value)
    }
}
