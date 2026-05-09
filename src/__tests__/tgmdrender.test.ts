import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
    tgmdConvert,
    tgmdConvertSync,
    tgmdSplit,
    tgmdTableImage,
    checkTgmdrender,
    resetTgmdStatus,
    type TgmdSegment,
} from '@/utils/tgmdrender'

// These tests require Python + telegramify-markdown + md2png-lite to be installed.
// If not available, the tgmdrender-specific tests will be skipped.

let available = false

beforeEach(() => {
    resetTgmdStatus()
})

describe('tgmdrender', () => {
    it('should detect availability', () => {
        const status = checkTgmdrender()
        available = status.available
        // Just verify it returns a status object
        expect(status).toHaveProperty('available')
        if (!status.available) {
            console.warn(`[tgmdrender test] Skipping: ${status.error}`)
        }
    })
})

describe('tgmdConvert (async)', () => {
    beforeEach(() => {
        resetTgmdStatus()
        const status = checkTgmdrender()
        available = status.available
    })

    it('should convert bold and inline code', async () => {
        if (!available) return
        const segments = await tgmdConvert('**bold** and `code`', { noSplit: true })
        expect(segments).toHaveLength(1)
        const seg = segments[0]
        expect(seg.kind).toBe('text')
        expect(seg.text).toBeDefined()
        expect(seg.entities).toBeDefined()
        // Bold entity should be present
        const boldEnt = seg.entities!.find(e => e.type === 'bold')
        expect(boldEnt).toBeDefined()
        // Code entity should be present
        const codeEnt = seg.entities!.find(e => e.type === 'code')
        expect(codeEnt).toBeDefined()
    })

    it('should detect tables when noSplit is false', async () => {
        if (!available) return
        const md = 'Some text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nMore text'
        const segments = await tgmdConvert(md)
        expect(segments.length).toBeGreaterThanOrEqual(2)
        const tableSeg = segments.find(s => s.kind === 'table')
        expect(tableSeg).toBeDefined()
        expect(tableSeg!.markdown).toContain('| a |')
    })

    it('should skip table detection with noSplit', async () => {
        if (!available) return
        const md = 'Text\n\n| a | b |\n|---|---|\n| 1 | 2 |'
        const segments = await tgmdConvert(md, { noSplit: true })
        const tableSeg = segments.find(s => s.kind === 'table')
        expect(tableSeg).toBeUndefined()
    })

    it('should handle empty input', async () => {
        if (!available) return
        const segments = await tgmdConvert(' ', { noSplit: true })
        expect(segments).toHaveLength(1)
        expect(segments[0].kind).toBe('text')
    }, 15000)
})

describe('tgmdConvertSync', () => {
    beforeEach(() => {
        resetTgmdStatus()
        const status = checkTgmdrender()
        available = status.available
    })

    it('should convert markdown synchronously', () => {
        if (!available) return
        const segments = tgmdConvertSync('**hello**', { noSplit: true })
        expect(segments).toHaveLength(1)
        expect(segments[0].kind).toBe('text')
        expect(segments[0].entities!.some(e => e.type === 'bold')).toBe(true)
    })
})

describe('tgmdSplit', () => {
    beforeEach(() => {
        resetTgmdStatus()
        const status = checkTgmdrender()
        available = status.available
    })

    it('should split markdown into chunks with entities', async () => {
        if (!available) return
        const segments = await tgmdSplit('**bold** and `code`')
        expect(segments.length).toBeGreaterThanOrEqual(1)
        const textSeg = segments.find(s => s.kind === 'text')
        expect(textSeg).toBeDefined()
        expect(textSeg!.entities!.length).toBeGreaterThan(0)
    })

    it('should detect tables in split output', async () => {
        if (!available) return
        const md = 'Text\n\n| h1 | h2 |\n|----|----|\n| c1 | c2 |\n\nMore'
        const segments = await tgmdSplit(md)
        const tableSeg = segments.find(s => s.kind === 'table')
        expect(tableSeg).toBeDefined()
        expect(tableSeg!.markdown).toContain('| h1 |')
    })

    it('should produce segments with kind field', async () => {
        if (!available) return
        const segments = await tgmdSplit('hello world')
        for (const seg of segments) {
            expect(seg).toHaveProperty('kind')
            expect(['text', 'table']).toContain(seg.kind)
        }
    })

    it('should respect maxUtf16 parameter', async () => {
        if (!available) return
        const longText = 'a'.repeat(5000)
        const segments = await tgmdSplit(longText, 1000)
        // Should be split into multiple chunks
        expect(segments.length).toBeGreaterThan(1)
        for (const seg of segments) {
            if (seg.kind === 'text' && seg.text) {
                // Each chunk should be within UTF-16 limit (with margin)
                const utf16Len = seg.text.length // ASCII chars = 1 UTF-16 unit each
                expect(utf16Len).toBeLessThanOrEqual(1100) // 1000 + some margin
            }
        }
    })
})

describe('tgmdTableImage', () => {
    beforeEach(() => {
        resetTgmdStatus()
        const status = checkTgmdrender()
        available = status.available
    })

    it('should render a markdown table as PNG buffer', async () => {
        if (!available) return
        const md = '| a | b |\n|---|---|\n| 1 | 2 |'
        const buf = await tgmdTableImage(md)
        expect(buf).toBeInstanceOf(Buffer)
        expect(buf.length).toBeGreaterThan(0)
        // PNG magic bytes
        expect(buf[0]).toBe(0x89)
        expect(buf[1]).toBe(0x50) // 'P'
        expect(buf[2]).toBe(0x4E) // 'N'
        expect(buf[3]).toBe(0x47) // 'G'
    })
})
