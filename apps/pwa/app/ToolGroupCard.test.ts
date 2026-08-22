import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolGroupCard } from './ToolGroupCard'
import type { ToolGroupPresentation } from './presentation'

describe('ToolGroupCard', () => {
    it('renders a completed Bash call as the dedicated terminal card', () => {
        const html = renderToStaticMarkup(createElement(ToolGroupCard, {
            group: toolGroup('completed'),
            time: '16:20',
        }))

        expect(html).toContain('tool-group-card category-execute')
        expect(html).toContain('tool-state phase-completed')
        expect(html).toContain('aria-label="Completed"')
        expect(html).toContain('<strong>Bash</strong>')
        expect(html).not.toContain('phase-updated')
    })

    it('keeps animation markup only while the Bash call is active', () => {
        const html = renderToStaticMarkup(createElement(ToolGroupCard, {
            group: toolGroup('updated'),
        }))

        expect(html).toContain('tool-state phase-updated')
        expect(html).toContain('aria-label="Running"')
        expect(html).toContain('<i aria-hidden="true"></i>')
    })
})

function toolGroup(
    phase: 'updated' | 'completed',
): ToolGroupPresentation {
    return {
        kind: 'tool_group',
        version: 1,
        groupId: 'bash-1',
        tools: [{
            id: 'bash-1',
            name: 'Bash',
            title: 'Bash',
            detail: 'pnpm test',
            category: 'execute',
            phase,
            isError: false,
            startedAt: 1,
            updatedAt: 2,
        }],
    }
}
