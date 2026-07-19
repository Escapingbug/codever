import { describe, expect, it, vi } from 'vitest'
import { CodeverApi } from './codeverApi'
import type { MatrixTransportEvent } from './nativeMatrixClient'

class FakeNativeMatrixClient {
  readonly chunks: Array<{ uploadId: string; offset: number; bytes: Uint8Array }> = []
  readonly cancelEncryptedMediaUpload = vi.fn(async () => undefined)
  failCommand = false
  private subscriber?: (event: MatrixTransportEvent) => void

  subscribe(subscriber: (event: MatrixTransportEvent) => void): () => void {
    this.subscriber = subscriber
    return () => { this.subscriber = undefined }
  }
  signExecution(): Promise<string> { return Promise.resolve('signed-cose-token') }
  beginEncryptedMediaUpload(sizeBytes: number) {
    return Promise.resolve({ uploadId: 'media-1', sizeBytes, receivedBytes: 0 })
  }
  appendEncryptedMediaUpload(uploadId: string, offset: number, bytes: Uint8Array) {
    this.chunks.push({ uploadId, offset, bytes })
    return Promise.resolve({ uploadId, sizeBytes: 300_000, receivedBytes: offset + bytes.length })
  }
  completeEncryptedMediaUpload() {
    return Promise.resolve({
      url: 'mxc://matrix.example/media', v: 'v2',
      key: { alg: 'A256CTR', ext: true, key_ops: ['encrypt', 'decrypt'], kty: 'oct', k: 'secret' },
      iv: 'iv', hashes: { sha256: 'hash' },
    })
  }
  close(): Promise<void> { return Promise.resolve() }
  async send(input: { content: unknown }): Promise<string> {
    if (this.failCommand) throw new Error('Matrix send failed')
    const content = input.content as { request: { requestId: string; payload: { sessionId: string } } }
    queueMicrotask(() => this.subscriber?.({
      roomId: '!control:matrix.example', encrypted: true, verifiedDevice: true,
      event: {
        type: 'io.codever.response.v1',
        content: {
          response: {
            version: 1, type: 'gateway.client.response', requestId: content.request.requestId,
            status: 'completed', completedAt: '2026-07-19T06:00:00.000Z',
            payload: {
              attachmentId: 'attachment-1', sessionId: content.request.payload.sessionId,
              filename: 'large.bin', mimeType: 'application/octet-stream',
              sizeBytes: 300_000, receivedBytes: 300_000, status: 'ready',
            },
          },
        },
      },
    }))
    return '$event'
  }
}

function connectedApi(native: FakeNativeMatrixClient): CodeverApi {
  const api = new CodeverApi(native as never)
  api.connect({
    session: { homeserver: 'https://matrix.example', userId: '@user:matrix.example', deviceId: 'PHONE' },
    controlRoomId: '!control:matrix.example', executionAccount: 'execution-user', executionKeyId: 'key-1',
  })
  api.rememberRoute('gateway-1', 'project-1', 'session-1')
  return api
}

describe('CodeverApi Matrix encrypted media upload', () => {
  it('stages bounded chunks and imports the encrypted Matrix descriptor', async () => {
    const native = new FakeNativeMatrixClient()
    const stages: string[] = []
    const progress: number[] = []
    const file = new File([new Uint8Array(300_000)], 'large.bin', { type: 'application/octet-stream' })

    const result = await connectedApi(native).uploadAttachment('session-1', file, {
      onStage: stage => stages.push(stage),
      onProgress: received => progress.push(received),
    })

    expect(native.chunks.map(chunk => [chunk.offset, chunk.bytes.length])).toEqual([
      [0, 256 * 1024], [256 * 1024, 300_000 - 256 * 1024],
    ])
    expect(stages).toEqual(['uploading', 'storing'])
    expect(progress).toEqual([256 * 1024, 300_000])
    expect(result).toMatchObject({ attachmentId: 'attachment-1', status: 'ready' })
  })

  it('cleans native staging if the authorized import command cannot be sent', async () => {
    const native = new FakeNativeMatrixClient()
    native.failCommand = true
    const file = new File([new Uint8Array(10)], 'large.bin', { type: 'application/octet-stream' })

    await expect(connectedApi(native).uploadAttachment('session-1', file)).rejects.toThrow('Matrix send failed')

    expect(native.cancelEncryptedMediaUpload).toHaveBeenCalledWith('media-1')
  })

  it('restarts a failed upload instead of using removed Gateway chunk state', async () => {
    const native = new FakeNativeMatrixClient()
    const file = new File([new Uint8Array(10)], 'large.bin')
    const api = connectedApi(native)

    await api.uploadAttachment('session-1', file, {
      resume: {
        attachmentId: 'stale-upload', sessionId: 'session-1', filename: 'large.bin',
        mimeType: 'application/octet-stream', sizeBytes: 10, receivedBytes: 5, status: 'uploading',
      },
    })

    expect(native.cancelEncryptedMediaUpload).toHaveBeenCalledWith('stale-upload')
    expect(native.chunks[0]?.offset).toBe(0)
  })
})
