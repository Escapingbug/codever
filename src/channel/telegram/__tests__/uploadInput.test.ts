import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRichInputFromTelegramMessage } from '@/channel/telegram/uploadInput'

const mocks = vi.hoisted(() => ({
    baseDir: '',
}))

vi.mock('@/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/config')>()
    return {
        ...actual,
        getDaemonBaseDir: () => mocks.baseDir,
    }
})

describe('Telegram upload rich input', () => {
    let tempDir: string
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'codever-upload-input-'))
        mocks.baseDir = tempDir
        globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as any
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        rmSync(tempDir, { recursive: true, force: true })
    })

    it('downloads Telegram photos into image content blocks', async () => {
        const api = {
            getFile: vi.fn(async () => ({ file_path: 'photos/file_1.jpg', file_size: 3 })),
        }

        const input = await buildRichInputFromTelegramMessage({
            api,
            botToken: 'token',
            topicKey: '-100:10',
            message: {
                caption: 'describe this',
                photo: [
                    { file_id: 'small', file_size: 1 },
                    { file_id: 'large', file_size: 3 },
                ],
            },
        })

        expect(api.getFile).toHaveBeenCalledWith('large')
        expect(input).toEqual({
            text: 'describe this',
            richInput: {
                parts: [
                    { type: 'text', text: 'describe this' },
                    {
                        type: 'image',
                        mimeType: 'image/jpeg',
                        data: 'AQID',
                        source: 'telegram:large',
                        filename: 'file_1.jpg',
                        sizeBytes: 3,
                    },
                ],
            },
        })
    })

    it('downloads generic documents into the Codever upload cache as file references', async () => {
        const api = {
            getFile: vi.fn(async () => ({ file_path: 'documents/report.pdf', file_size: 3 })),
        }

        const input = await buildRichInputFromTelegramMessage({
            api,
            botToken: 'token',
            topicKey: '-100:10',
            message: {
                caption: 'read this',
                document: {
                    file_id: 'doc-1',
                    file_name: '../report.pdf',
                    mime_type: 'application/pdf',
                    file_size: 3,
                },
            },
        })

        expect(input.text).toBe('read this')
        expect(input.richInput.parts[0]).toEqual({ type: 'text', text: 'read this' })
        expect(input.richInput.parts[1]).toEqual(expect.objectContaining({
            type: 'file',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 3,
        }))
        expect(String((input.richInput.parts[1] as any).path)).toContain(join(tempDir, 'uploads'))
    })
})
