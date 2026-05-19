import { describe, expect, it } from 'vitest'
import { buildAcpPrompt } from '@/providers/acp'

describe('ACP rich prompt mapping', () => {
    it('maps text and image rich input to ACP content blocks when image is supported', async () => {
        const blocks = await buildAcpPrompt({
            parts: [
                { type: 'text', text: 'what is in this image?' },
                {
                    type: 'image',
                    mimeType: 'image/png',
                    data: 'aW1hZ2U=',
                    source: 'telegram:file-photo-1',
                    filename: 'photo.png',
                    sizeBytes: 5,
                },
            ],
        }, { image: true })

        expect(blocks).toEqual([
            { type: 'text', text: 'what is in this image?' },
            {
                type: 'image',
                mimeType: 'image/png',
                data: 'aW1hZ2U=',
                source: 'telegram:file-photo-1',
            },
        ])
    })

    it('falls back to explanatory text when audio is not supported', async () => {
        const blocks = await buildAcpPrompt({
            parts: [
                {
                    type: 'audio',
                    mimeType: 'audio/ogg',
                    data: 'YXVkaW8=',
                    filename: 'voice.ogg',
                    sizeBytes: 5,
                },
            ],
        }, { audio: false })

        expect(blocks).toEqual([
            {
                type: 'text',
                text: 'The user uploaded audio voice.ogg (audio/ogg, 5 bytes), but this ACP agent does not advertise audio prompt support.',
            },
        ])
    })
})
