import { describe, it, expect } from 'vitest'
import { StructureDetector } from '@/middleware/structureDetector'

describe('StructureDetector', () => {
    const detector = new StructureDetector()

    describe('detect', () => {
        it('returns all-false for empty string', () => {
            const state = detector.detect('')
            expect(state.inCodeBlock).toBe(false)
            expect(state.inTable).toBe(false)
            expect(state.inList).toBe(false)
            expect(state.inBlockquote).toBe(false)
        })

        it('returns all-false for plain text with no markdown', () => {
            const state = detector.detect('Hello world')
            expect(state.inCodeBlock).toBe(false)
            expect(state.inTable).toBe(false)
        })

        describe('code blocks', () => {
            it('detects unclosed backtick code block', () => {
                expect(detector.detect('```js\nconsole.log("hello")').inCodeBlock).toBe(true)
            })

            it('detects closed backtick code block', () => {
                expect(detector.detect('```js\ncode\n```').inCodeBlock).toBe(false)
            })

            it('detects unclosed tilde code block', () => {
                expect(detector.detect('~~~python\nprint("hello")').inCodeBlock).toBe(true)
            })

            it('detects closed tilde code block', () => {
                expect(detector.detect('~~~python\ncode\n~~~').inCodeBlock).toBe(false)
            })

            it('detects multiple opened code blocks', () => {
                expect(detector.detect('```\ncode1\n```\n```\ncode2').inCodeBlock).toBe(true)
            })

            it('detects balanced code blocks', () => {
                expect(detector.detect('```\ncode1\n```\n```\ncode2\n```').inCodeBlock).toBe(false)
            })

            it('ignores inline code (single backticks)', () => {
                expect(detector.detect('Use `code` here').inCodeBlock).toBe(false)
            })

            it('ignores double backticks that are not fences', () => {
                expect(detector.detect('Text with ``code`` inline').inCodeBlock).toBe(false)
            })
        })

        describe('tables', () => {
            it('detects unclosed table (trailing | line with no blank line)', () => {
                expect(detector.detect('| A | B |\n|---|---|\n| 1 | 2 |').inTable).toBe(true)
            })

            it('detects closed table (blank line after)', () => {
                expect(detector.detect('| A | B |\n|---|---|\n| 1 | 2 |\n\nNext text').inTable).toBe(false)
            })

            it('detects table followed by blank line at end', () => {
                expect(detector.detect('| A | B |\n|---|---|\n| 1 | 2 |\n').inTable).toBe(false)
            })

            it('detects table row without separator', () => {
                expect(detector.detect('| A | B |\n| 1 | 2 |').inTable).toBe(true)
            })
        })

        describe('lists', () => {
            it('detects unclosed list (trailing - item with no blank line)', () => {
                expect(detector.detect('- item 1\n- item 2').inList).toBe(true)
            })

            it('detects closed list (blank line after)', () => {
                expect(detector.detect('- item 1\n- item 2\n\nDone').inList).toBe(false)
            })

            it('detects unclosed ordered list', () => {
                expect(detector.detect('1. first\n2. second').inList).toBe(true)
            })

            it('detects ordered list followed by blank line', () => {
                expect(detector.detect('1. first\n2. second\n\nDone').inList).toBe(false)
            })

            it('detects list followed by blank line at end', () => {
                expect(detector.detect('- item 1\n- item 2\n').inList).toBe(false)
            })
        })

        describe('blockquotes', () => {
            it('detects unclosed blockquote', () => {
                expect(detector.detect('> quote line 1\n> quote line 2').inBlockquote).toBe(true)
            })

            it('detects closed blockquote (blank line after)', () => {
                expect(detector.detect('> quote line\n\nDone').inBlockquote).toBe(false)
            })

            it('detects blockquote followed by blank line at end', () => {
                expect(detector.detect('> quote line\n').inBlockquote).toBe(false)
            })
        })

        describe('combined structures', () => {
            it('code block inside list is detected by code block', () => {
                const state = detector.detect('- item\n  ```\n  code')
                expect(state.inCodeBlock).toBe(true)
            })

            it('all structures closed', () => {
                const state = detector.detect('```\ncode\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone')
                expect(state.inCodeBlock).toBe(false)
                expect(state.inTable).toBe(false)
                expect(state.inList).toBe(false)
                expect(state.inBlockquote).toBe(false)
            })
        })
    })

    describe('findStructureBoundary', () => {
        it('returns maxLen when no structure boundaries found', () => {
            const buffer = 'A'.repeat(5000)
            expect(detector.findStructureBoundary(buffer, 3800)).toBe(3800)
        })

        it('finds blank line boundary', () => {
            const buffer = 'A'.repeat(3000) + '\n\n' + 'B'.repeat(2000)
            const boundary = detector.findStructureBoundary(buffer, 3800)
            expect(boundary).toBeLessThanOrEqual(3800)
            expect(boundary).toBe(3000 + 2) // at the \n\n
        })

        it('finds heading line as boundary', () => {
            const buffer = 'A'.repeat(3500) + '\n# Heading\n' + 'B'.repeat(1000)
            const boundary = detector.findStructureBoundary(buffer, 3800)
            expect(boundary).toBeLessThanOrEqual(3800)
            expect(boundary).toBe(3500 + 1) // at the \n before #
        })

        it('does not split mid-code-block', () => {
            const codeStart = '```js\n' + 'A'.repeat(3500) + '\n```'
            const buffer = codeStart + '\n\n' + 'B'.repeat(500)
            const boundary = detector.findStructureBoundary(buffer, 3800)
            // Should find the blank line AFTER the code block, not split inside it
            expect(boundary).toBe(codeStart.length + 2) // at \n\n after code block
        })

        it('prefers blank line over heading', () => {
            const buffer = 'A'.repeat(2000) + '\n\n' + 'B'.repeat(500) + '\n# Heading\n' + 'C'.repeat(2000)
            const boundary = detector.findStructureBoundary(buffer, 3800)
            expect(boundary).toBe(2000 + 2) // at \n\n
        })

        it('prefers paragraph break (blank line) over line break', () => {
            const buffer = 'Line 1\nLine 2\nLine 3\n\nParagraph 2\nLine 4\nLine 5'
            const boundary = detector.findStructureBoundary(buffer, 40)
            // Should find the \n\n, not just \n
            expect(buffer.slice(0, boundary)).toContain('\n\n')
        })

        it('falls back to line break when no blank line within maxLen', () => {
            const buffer = 'A'.repeat(2000) + '\n' + 'B'.repeat(2000)
            const boundary = detector.findStructureBoundary(buffer, 3800)
            expect(boundary).toBeLessThanOrEqual(3800)
            expect(boundary).toBe(2000 + 1) // at \n
        })

        it('returns maxLen when buffer is shorter', () => {
            const buffer = 'Short text'
            expect(detector.findStructureBoundary(buffer, 3800)).toBe(3800)
        })
    })
})
