import { describe, it, expect } from 'vitest'
import { formatToolBubble } from '../toolBubble'
import type { ToolBubbleState } from '../toolBubble'

describe('toolBubble — displayTitle support', () => {
    it('shows displayTitle for Read tool', () => {
        const state: ToolBubbleState = {
            toolName: 'Read',
            input: { file_path: '/src/foo.ts' },
            status: 'completed',
            displayTitle: '/src/foo.ts',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('/src/foo.ts')
        expect(result).toContain('Read')
    })

    it('supports aliases: todo_write → TodoWrite', () => {
        const state: ToolBubbleState = {
            toolName: 'todo_write',
            input: { todos: [] },
            status: 'completed',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Tasks')
    })

    it('supports aliases: read_file → Read', () => {
        const state: ToolBubbleState = {
            toolName: 'read_file',
            input: { file_path: '/src/bar.ts' },
            status: 'running',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Read')
    })

    it('supports aliases: edit_file → Edit', () => {
        const state: ToolBubbleState = {
            toolName: 'edit_file',
            input: { file_path: '/src/baz.ts' },
            status: 'running',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Edit')
    })

    it('supports aliases: write_file → Write', () => {
        const state: ToolBubbleState = {
            toolName: 'write_file',
            input: { file_path: '/src/qux.ts' },
            status: 'running',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Write')
    })

    it('supports aliases: web_search → WebSearch', () => {
        const state: ToolBubbleState = {
            toolName: 'web_search',
            input: { query: 'test query' },
            status: 'running',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Search')
    })

    it('supports aliases: web_fetch → WebFetch', () => {
        const state: ToolBubbleState = {
            toolName: 'web_fetch',
            input: { url: 'https://example.com' },
            status: 'running',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Fetch')
    })

    it('supports exit_plan_mode alias', () => {
        const state: ToolBubbleState = {
            toolName: 'exit_plan_mode',
            input: { plan: 'Plan content here' },
            status: 'completed',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Plan')
        expect(result).toContain('Plan content here')
    })
})

describe('toolBubble — interactive and unknown tool inputs', () => {
    it('renders CodeBuddy AskUserQuestion questions, choices, and descriptions', () => {
        const result = formatToolBubble({
            toolName: 'AskUserQuestion',
            input: {
                questions: [{
                    header: 'Database',
                    question: 'Which database should we use?',
                    options: [
                        { label: 'PostgreSQL', description: 'Relational database' },
                        { label: 'MongoDB', description: 'Document database' },
                    ],
                    multiSelect: false,
                }],
            },
            status: 'running',
        })

        expect(result).toContain('Which database should we use?')
        expect(result).toContain('PostgreSQL')
        expect(result).toContain('Relational database')
    })

    it('shows redacted, bounded input for otherwise unknown tools', () => {
        const result = formatToolBubble({
            toolName: 'DeployWidget',
            input: {
                environment: 'staging',
                apiKey: 'super-secret-value',
                accessToken: 'another-secret-value',
            },
            status: 'running',
            showGenericInput: true,
        })

        expect(result).toContain('environment')
        expect(result).toContain('staging')
        expect(result).toContain('[REDACTED]')
        expect(result).not.toContain('super-secret-value')
        expect(result).not.toContain('another-secret-value')
        expect(result.length).toBeLessThan(1_500)
    })

    it('keeps unknown tool payloads hidden unless verbose input is requested', () => {
        const result = formatToolBubble({
            toolName: 'DeployWidget',
            input: { environment: 'staging' },
            status: 'running',
        })

        expect(result).toContain('DeployWidget')
        expect(result).not.toContain('environment')
        expect(result).not.toContain('staging')
    })
})

describe('toolBubble — Read/Edit/Write path support', () => {
    it('Read supports file_path, filePath, and path', () => {
        const inputs = [
            { file_path: '/src/a.ts' },
            { filePath: '/src/b.ts' },
            { path: '/src/c.ts' },
        ]

        for (const input of inputs) {
            const state: ToolBubbleState = {
                toolName: 'Read',
                input,
                status: 'completed',
            }
            const result = formatToolBubble(state)
            expect(result).toMatch(/Read.*code>/)
        }
    })

    it('Read supports diff content path when input is missing', () => {
        const state: ToolBubbleState = {
            toolName: 'Read',
            input: undefined,
            status: 'completed',
            content: [{ type: 'diff', path: '/src/from-content.ts', newText: 'content' }],
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Read')
        expect(result).toContain('/src/from-content.ts')
    })

    it('shows diff content paths for generic tools', () => {
        const state: ToolBubbleState = {
            toolName: 'updateTodos',
            input: undefined,
            status: 'completed',
            content: [{ type: 'diff', path: '/tests/test_verification.py', newText: 'content' }],
        }

        const result = formatToolBubble(state)
        expect(result).toContain('updateTodos')
        expect(result).toContain('/tests/test_verification.py')
        expect(result).not.toContain('<pre>{')
    })

    it('Edit supports file_path, filePath, and path', () => {
        const inputs = [
            { file_path: '/src/a.ts' },
            { filePath: '/src/b.ts' },
            { path: '/src/c.ts' },
        ]

        for (const input of inputs) {
            const state: ToolBubbleState = {
                toolName: 'Edit',
                input,
                status: 'completed',
            }
            const result = formatToolBubble(state)
            expect(result).toMatch(/Edit.*code>/)
        }
    })

    it('Write supports file_path, filePath, and path', () => {
        const inputs = [
            { file_path: '/src/a.ts' },
            { filePath: '/src/b.ts' },
            { path: '/src/c.ts' },
        ]

        for (const input of inputs) {
            const state: ToolBubbleState = {
                toolName: 'Write',
                input,
                status: 'completed',
            }
            const result = formatToolBubble(state)
            expect(result).toMatch(/Write.*code>/)
        }
    })
})

describe('toolBubble — search result summaries', () => {
    it('renders preformatted Grep match summaries without recounting lines', () => {
        const result = formatToolBubble({
            toolName: 'Grep',
            input: {},
            status: 'completed',
            output: '0 matches',
        })

        expect(result).toContain('0 matches')
        expect(result).not.toContain('1 match')
    })

    it('renders preformatted Find file summaries through search tools', () => {
        const result = formatToolBubble({
            toolName: 'Grep',
            input: {},
            status: 'completed',
            output: '2 files',
        })

        expect(result).toContain('2 files')
    })
})

describe('toolBubble — ExitPlanMode shows full plan', () => {
    it('shows full plan content when plan/content is provided', () => {
        const planContent = '1. Analyze the codebase\n2. Implement feature X\n3. Write tests\n4. Update documentation'
        const state: ToolBubbleState = {
            toolName: 'ExitPlanMode',
            input: { plan: planContent },
            status: 'completed',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Plan')
        expect(result).toContain('Analyze the codebase')
        expect(result).toContain('Implement feature X')
        // Should NOT just say "ready"
        expect(result).not.toContain('ready')
    })

    it('shows full plan content from content field', () => {
        const planContent = 'Detailed plan content here'
        const state: ToolBubbleState = {
            toolName: 'ExitPlanMode',
            input: { content: planContent },
            status: 'completed',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Plan')
        expect(result).toContain(planContent)
    })

    it('shows displayTitle as plan content if provided', () => {
        const planContent = 'Plan from displayTitle'
        const state: ToolBubbleState = {
            toolName: 'ExitPlanMode',
            input: {},
            status: 'completed',
            displayTitle: planContent,
        }

        const result = formatToolBubble(state)
        expect(result).toContain('Plan')
        expect(result).toContain(planContent)
    })
})

describe('toolBubble — formatToolBubble renders correctly', () => {
    it('renders running status with ⏳', () => {
        const state: ToolBubbleState = {
            toolName: 'Bash',
            input: { command: 'ls -la' },
            status: 'running',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('⏳')
        expect(result).toContain('ls -la')
    })

    it('renders interrupted status with ⏹️', () => {
        const state: ToolBubbleState = {
            toolName: 'Bash',
            input: { command: 'sleep 100' },
            status: 'interrupted',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('⏹️')
    })

    it('renders TodoWrite with todo list', () => {
        const state: ToolBubbleState = {
            toolName: 'TodoWrite',
            input: {
                todos: [
                    { content: 'Task 1', status: 'completed' },
                    { content: 'Task 2', status: 'in_progress' },
                    { content: 'Task 3', status: 'pending' },
                ],
            },
            status: 'completed',
        }

        const result = formatToolBubble(state)
        expect(result).toContain('✅')
        expect(result).toContain('🔄')
        expect(result).toContain('⬜')
    })
})
