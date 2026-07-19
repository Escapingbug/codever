import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { JsonObject } from '@codever/protocol'

export const MATRIX_COMMAND_EVENT = 'io.codever.command.v1'
export const MATRIX_RESPONSE_EVENT = 'io.codever.response.v1'
export const MATRIX_CONVERSATION_EVENT = 'io.codever.conversation.v1'
export const MATRIX_INVENTORY_EVENT = 'io.codever.inventory.v1'
export const MATRIX_GATEWAY_EVENT = 'io.codever.gateway.v1'
export const MATRIX_DISCOVERY_EVENT = 'io.codever.discovery.v1'
export const MATRIX_AUTHORIZATION_EVENT = 'io.codever.authorization.v1'
export const MATRIX_EVENT_NAME = 'codever://matrix-event'

export interface MatrixPublicSession {
  homeserver: string
  userId: string
  deviceId: string
}

export interface MatrixTransportEvent {
  roomId: string
  event: { type?: string; content?: unknown; event_id?: string; sender?: string }
  encrypted: boolean
  verifiedDevice: boolean
  senderDevice?: string
}

export interface ExecutionIdentity {
  keyId: string
  publicKey: Record<string, unknown>
}

export interface MatrixVerificationSnapshot {
  flowId: string
  stage: 'created' | 'requested' | 'ready' | 'sas' | 'present_sas' | 'done' | 'cancelled' | 'unsupported'
  otherDeviceId?: string
  emojis?: Array<{ symbol: string; description: string }>
  cancellation?: { code: string; reason: string; cancelledByUs: boolean }
}

export interface MatrixDeviceSnapshot {
  deviceId: string
  displayName?: string
  verified: boolean
  current: boolean
}

export interface MatrixMediaUploadSnapshot {
  uploadId: string
  sizeBytes: number
  receivedBytes: number
}

export interface SignExecutionInput {
  request: unknown
  gatewayId: string
  issuer: string
  subject: string
  operation: string
  ttlSeconds?: number
}

export class NativeMatrixClient {
  private unlisten?: UnlistenFn
  private readonly subscribers = new Set<(event: MatrixTransportEvent) => void>()
  private readonly backlog: MatrixTransportEvent[] = []

  async login(input: {
    homeserver: string
    username: string
    password: string
    deviceDisplayName: string
    secretAccount: string
  }): Promise<MatrixPublicSession> {
    this.requireNative()
    await this.listen()
    return invoke<MatrixPublicSession>('matrix_login', { input })
  }

  async restore(session: MatrixPublicSession, secretAccount: string): Promise<void> {
    this.requireNative()
    await this.listen()
    await invoke('matrix_initialize', { session, secretAccount })
  }

  async ensureControlRoom(): Promise<string> {
    return invoke<string>('matrix_ensure_control_room')
  }

  async send(input: {
    roomId: string
    eventType: string
    transactionId: string
    content: unknown
  }): Promise<string> {
    return invoke<string>('matrix_send', input)
  }

  async createExecutionIdentity(account: string): Promise<ExecutionIdentity> {
    return invoke<ExecutionIdentity>('execution_identity_create', { account })
  }

  requestVerification(deviceId: string): Promise<MatrixVerificationSnapshot> {
    return invoke('matrix_verification_request', { deviceId })
  }

  listDevices(): Promise<MatrixDeviceSnapshot[]> {
    return invoke('matrix_devices')
  }

  listVerifications(): Promise<MatrixVerificationSnapshot[]> {
    return invoke('matrix_verification_list')
  }

  advanceVerification(flowId: string): Promise<MatrixVerificationSnapshot> {
    return invoke('matrix_verification_advance', { flowId })
  }

  confirmVerification(flowId: string, matches: boolean): Promise<MatrixVerificationSnapshot> {
    return invoke('matrix_verification_confirm', { flowId, matches })
  }

  cancelVerification(flowId: string): Promise<void> {
    return invoke('matrix_verification_cancel', { flowId })
  }

  beginEncryptedMediaUpload(sizeBytes: number): Promise<MatrixMediaUploadSnapshot> {
    return invoke('matrix_media_upload_begin', { sizeBytes })
  }

  appendEncryptedMediaUpload(uploadId: string, offset: number, bytes: Uint8Array): Promise<MatrixMediaUploadSnapshot> {
    return invoke('matrix_media_upload_chunk', { uploadId, offset, data: bytesToBase64(bytes) })
  }

  completeEncryptedMediaUpload(uploadId: string): Promise<JsonObject> {
    return invoke('matrix_media_upload_complete', { uploadId })
  }

  cancelEncryptedMediaUpload(uploadId: string): Promise<void> {
    return invoke('matrix_media_upload_cancel', { uploadId })
  }

  async signExecution(account: string, input: SignExecutionInput): Promise<string> {
    return invoke<string>('execution_sign', { account, input })
  }

  subscribe(subscriber: (event: MatrixTransportEvent) => void): () => void {
    this.subscribers.add(subscriber)
    for (const event of this.backlog) subscriber(event)
    return () => this.subscribers.delete(subscriber)
  }

  async close(): Promise<void> {
    this.unlisten?.()
    this.unlisten = undefined
    this.subscribers.clear()
    this.backlog.length = 0
    if (isTauri()) await invoke('matrix_close')
  }

  private async listen(): Promise<void> {
    if (this.unlisten) return
    this.unlisten = await listen<MatrixTransportEvent>(MATRIX_EVENT_NAME, ({ payload }) => {
      this.backlog.push(payload)
      if (this.backlog.length > 2_000) this.backlog.splice(0, this.backlog.length - 2_000)
      for (const subscriber of this.subscribers) subscriber(payload)
    })
  }

  private requireNative(): void {
    if (!isTauri()) throw new Error('The secure Matrix transport requires the Codever native app')
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
