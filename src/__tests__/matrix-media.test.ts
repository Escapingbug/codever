import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryMatrixTransport } from '@/channel/matrix'
import { materializePromptInput } from '@/gateway/matrix/media'
import { encryptMedia, sha256 } from '@codever/security'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })),
    )
})

describe('Matrix prompt attachments', () => {
    it('authenticates and forwards images as ACP-ready rich input', async () => {
        const cacheRoot = await temporaryDirectory()
        const transport = new InMemoryMatrixTransport()
        const plaintext = new TextEncoder().encode('image bytes')
        const attachment = await uploadFixture(transport, plaintext, 'diagram.png', 'image/png')

        const input = await materializePromptInput({
            operation: 'prompt',
            sessionId: 'session-1',
            text: 'Inspect this image',
            attachments: [attachment],
        }, transport, cacheRoot)

        expect(input.parts).toEqual([
            { type: 'text', text: 'Inspect this image' },
            {
                type: 'image',
                mimeType: 'image/png',
                data: Buffer.from(plaintext).toString('base64'),
                source: 'pwa-attachment:attachment-1',
                filename: 'diagram.png',
                sizeBytes: plaintext.byteLength,
            },
        ])
    })

    it('caches non-media files without trusting a client path', async () => {
        const cacheRoot = await temporaryDirectory()
        const transport = new InMemoryMatrixTransport()
        const plaintext = new TextEncoder().encode('report contents')
        const attachment = await uploadFixture(
            transport,
            plaintext,
            '../../report.txt',
            'text/plain',
        )

        const input = await materializePromptInput({
            operation: 'prompt',
            sessionId: 'session-1',
            text: '',
            attachments: [attachment],
        }, transport, cacheRoot)

        const file = input.parts[0]
        expect(file.type).toBe('file')
        if (file.type !== 'file') throw new Error('Expected a file input')
        expect(file.path.startsWith(cacheRoot)).toBe(true)
        expect(file.path).not.toContain('../')
        expect(await readFile(file.path, 'utf8')).toBe('report contents')
    })

    it('rejects plaintext that does not match signed attachment metadata', async () => {
        const cacheRoot = await temporaryDirectory()
        const transport = new InMemoryMatrixTransport()
        const plaintext = new TextEncoder().encode('image bytes')
        const attachment = await uploadFixture(transport, plaintext, 'diagram.png', 'image/png')

        await expect(materializePromptInput({
            operation: 'prompt',
            sessionId: 'session-1',
            text: '',
            attachments: [{ ...attachment, sha256: 'A'.repeat(43) }],
        }, transport, cacheRoot)).rejects.toThrow('integrity check failed')
    })
})

async function uploadFixture(
    transport: InMemoryMatrixTransport,
    plaintext: Uint8Array,
    name: string,
    mimeType: string,
) {
    const encrypted = await encryptMedia(plaintext)
    const uploaded = await transport.uploadEncryptedMedia({
        ciphertext: encrypted.ciphertext,
    })
    return {
        id: 'attachment-1',
        name,
        mimeType,
        size: plaintext.byteLength,
        sha256: await sha256(plaintext),
        media: {
            url: uploaded.url,
            ...encrypted.descriptor,
        },
    }
}

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'codever-matrix-media-'))
    temporaryDirectories.push(directory)
    return directory
}
