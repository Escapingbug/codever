import type { ClientGatewayResponseFrame } from '@codever/protocol'
import { readCached, writeCachedDurable } from '../state/localCache'
import type { DurableResponseStore } from './durableSyncClient'

export class IndexedDbDurableResponseStore implements DurableResponseStore {
  constructor(
    private readonly relayProfileId: string,
    private readonly credentialId: string,
  ) {}

  get(gatewayId: string, commandId: string): Promise<ClientGatewayResponseFrame | undefined> {
    return readCached(this.key(gatewayId, commandId))
  }

  put(gatewayId: string, commandId: string, response: ClientGatewayResponseFrame): Promise<void> {
    return writeCachedDurable(this.key(gatewayId, commandId), response)
  }

  private key(gatewayId: string, commandId: string): string {
    return `durable-response:${this.relayProfileId}:${this.credentialId}:${gatewayId}:${commandId}`
  }
}
