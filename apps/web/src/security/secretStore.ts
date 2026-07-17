import { invoke } from '@tauri-apps/api/core'

export interface SecretStore {
  get(account: string): Promise<string | undefined>
  set(account: string, value: string): Promise<void>
  delete(account: string): Promise<void>
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()
  async get(account: string): Promise<string | undefined> { return this.values.get(account) }
  async set(account: string, value: string): Promise<void> { this.values.set(account, value) }
  async delete(account: string): Promise<void> { this.values.delete(account) }
}

class TauriKeyringSecretStore implements SecretStore {
  async get(account: string): Promise<string | undefined> {
    return (await invoke<string | null>('secure_secret_get', { account })) ?? undefined
  }
  async set(account: string, value: string): Promise<void> {
    await invoke('secure_secret_set', { account, value })
  }
  async delete(account: string): Promise<void> {
    await invoke('secure_secret_delete', { account })
  }
}

export function createPlatformSecretStore(): SecretStore {
  return '__TAURI_INTERNALS__' in globalThis ? new TauriKeyringSecretStore() : new MemorySecretStore()
}
