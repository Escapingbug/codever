import { describe, expect, it } from 'vitest'
import { escapeHtml } from '@/utils/formatting'

describe('escapeHtml', () => {
    it('escapes strings and safely stringifies non-string values', () => {
        expect(escapeHtml('<tag attr="x">&')).toBe('&lt;tag attr=&quot;x&quot;&gt;&amp;')
        expect(escapeHtml(42)).toBe('42')
        expect(escapeHtml(null)).toBe('')
        expect(escapeHtml({ path: 'src/index.ts' })).toBe('[object Object]')
    })
})
