import { chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  importDeviceKeyPair,
  type DeviceKeyPair,
  type SerializedDeviceKeyPair,
} from '@codever/security'
import { AtomicJsonFile, type FileStoreOptions } from '@codever/security/node'

export interface GatewayIdentityState {
  version: 1
  gatewayId: string
  createdAt: number
  keyPair: SerializedDeviceKeyPair
}

export interface GatewayPairingIdentity {
  gatewayId: string
  createdAt: number
  keys: DeviceKeyPair
  serialized: SerializedDeviceKeyPair
}

export class FileGatewayIdentityStore {
  private readonly file: AtomicJsonFile<GatewayIdentityState>

  constructor(
    private readonly path: string,
    options: FileStoreOptions = {},
  ) {
    this.file = new AtomicJsonFile(path, options)
  }

  async loadOrCreate(
    gatewayId: string = randomUUID(),
    now = Date.now(),
  ): Promise<GatewayPairingIdentity> {
    const generated = await generateDeviceKeyPair()
    const candidate: GatewayIdentityState = {
      version: 1,
      gatewayId,
      createdAt: now,
      keyPair: await exportDeviceKeyPair(generated),
    }
    const stored = await this.file.transaction(
      () => candidate,
      (state) => {
        validateIdentityState(state)
        return { result: structuredClone(state), changed: state === candidate }
      },
    )
    if (process.platform !== 'win32') await chmod(this.path, 0o600)
    return {
      gatewayId: stored.gatewayId,
      createdAt: stored.createdAt,
      keys: await importDeviceKeyPair(stored.keyPair),
      serialized: stored.keyPair,
    }
  }
}

function validateIdentityState(value: GatewayIdentityState): void {
  if (
    value.version !== 1 ||
    typeof value.gatewayId !== 'string' ||
    !value.gatewayId ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    throw new TypeError('Gateway identity state is invalid')
  }
}
