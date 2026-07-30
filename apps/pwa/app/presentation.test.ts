import { describe, expect, it } from 'vitest'
import {
    messageFormat,
    parseToolGroupPresentation,
} from './presentation'
import { parseCodeverEvent } from './matrix'

describe('PWA structured presentation parsing', () => {
    it('accepts a bounded, typed tool group snapshot', () => {
        expect(parseToolGroupPresentation({
            kind: 'tool_group',
            version: 1,
            groupId: 'group-1',
            tools: [
                {
                    id: 'tool-1',
                    name: 'Bash',
                    title: 'Bash',
                    detail: 'npm test',
                    category: 'execute',
                    phase: 'completed',
                    isError: false,
                    startedAt: 1_000,
                    updatedAt: 2_000,
                },
                {
                    id: 'tool-2',
                    name: 'Read',
                    title: '/repo/app.ts',
                    category: 'read',
                    phase: 'updated',
                    isError: false,
                    startedAt: 2_100,
                    updatedAt: 2_200,
                },
            ],
        })).toMatchObject({
            groupId: 'group-1',
            tools: [
                { id: 'tool-1', detail: 'npm test' },
                { id: 'tool-2', phase: 'updated' },
            ],
        })
    })

    it('rejects malformed tool groups and unsafe format declarations', () => {
        expect(parseToolGroupPresentation({
            kind: 'tool_group',
            version: 1,
            groupId: 'group-1',
            tools: [{ id: 'missing-required-fields' }],
        })).toBeUndefined()
        expect(messageFormat('markdown')).toBe('markdown')
        expect(messageFormat('org.matrix.custom.html')).toBe('plain')
        expect(messageFormat('<script>')).toBe('plain')
    })

    it('preserves Markdown format and classifies structured Matrix tool groups', () => {
        expect(parseCodeverEvent(
            '$markdown',
            '@gateway:example.org',
            1_000,
            true,
            {
                body: '**Rendered**',
                'io.codever': {
                    version: 1,
                    kind: 'message',
                    format: 'markdown',
                },
            },
        )).toMatchObject({
            kind: 'agent',
            text: '**Rendered**',
            format: 'markdown',
        })

        expect(parseCodeverEvent(
            '$tools',
            '@gateway:example.org',
            2_000,
            true,
            {
                body: 'Read',
                'io.codever': {
                    version: 1,
                    kind: 'message',
                    format: 'html',
                    ui: {
                        kind: 'tool_group',
                        version: 1,
                        groupId: 'group-1',
                        tools: [{
                            id: 'tool-1',
                            name: 'Read',
                            title: '/repo/app.ts',
                            category: 'read',
                            phase: 'completed',
                            isError: false,
                            startedAt: 1_000,
                            updatedAt: 2_000,
                        }],
                    },
                },
            },
        )).toMatchObject({
            kind: 'tool',
            format: 'html',
            toolGroup: {
                groupId: 'group-1',
                tools: [{ id: 'tool-1', phase: 'completed' }],
            },
        })
    })
})
