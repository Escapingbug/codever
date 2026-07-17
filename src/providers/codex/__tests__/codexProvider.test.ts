import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCodexModels } from '../index'

const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const { acpProviderConfigs } = vi.hoisted(() => ({
    acpProviderConfigs: [] as Array<{ name: string; command: string; args: string[] }>,
}))

const { spawnSyncMock } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        spawnSync: spawnSyncMock,
    }
})

vi.mock('@/providers/acp', () => ({
    AcpProvider: class {
        readonly name: string

        constructor(config: { name: string; command: string; args: string[] }) {
            this.name = config.name
            acpProviderConfigs.push(config)
        }
    },
}))

describe('CodexProvider', () => {
    it('launches Codex through the ACP adapter over stdio', async () => {
        const { CodexProvider } = await import('../index')

        const provider = new CodexProvider()

        expect(provider.name).toBe('codex')
        expect(acpProviderConfigs).toEqual([
            {
                name: 'codex',
                command: 'npx',
                args: ['-y', '@agentclientprotocol/codex-acp'],
            },
        ])
    })

    it('lists subscription models from codex debug models', async () => {
        const { CodexProvider } = await import('../index')
        spawnSyncMock.mockReturnValue({
            status: 0,
            error: undefined,
            stdout: JSON.stringify({
                models: [
                    {
                        slug: 'gpt-5.5',
                        display_name: 'GPT-5.5',
                        visibility: 'list',
                        default_reasoning_level: 'medium',
                        supported_reasoning_levels: [
                            { effort: 'low', description: 'Fast' },
                            { effort: 'medium', description: 'Balanced' },
                        ],
                    },
                    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hidden' },
                ],
            }),
            stderr: '',
        })

        expect(new CodexProvider().getAvailableModels()).toEqual([
            {
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                provider: 'openai',
                defaultReasoningLevel: 'medium',
                supportedReasoningLevels: [
                    { effort: 'low', description: 'Fast' },
                    { effort: 'medium', description: 'Balanced' },
                ],
            },
        ])
        expect(spawnSyncMock).toHaveBeenCalled()
    })

    it('lists Codex rollout sessions for the requested cwd', async () => {
        const { CodexProvider } = await import('../index')
        const codexHome = await createCodexHome([
            {
                id: 'session-for-project',
                cwd: path.join(tmpdir(), 'project'),
                message: 'Fix the session listing for Codex',
                timestamp: '2026-07-15T03:00:00.000Z',
            },
            {
                id: 'session-for-other-project',
                cwd: path.join(tmpdir(), 'other'),
                message: 'Unrelated work',
                timestamp: '2026-07-15T04:00:00.000Z',
            },
        ])

        const sessions = await new CodexProvider({ codexHome }).listSessions(path.join(tmpdir(), 'project'))

        expect(sessions).toHaveLength(1)
        expect(sessions[0]).toMatchObject({
            sessionId: 'session-for-project',
            title: 'Fix the session listing for Codex',
            firstMessage: 'Fix the session listing for Codex',
            cwd: path.join(tmpdir(), 'project'),
        })
    })

    it('returns a session first message and tolerates malformed rollout lines', async () => {
        const { CodexProvider } = await import('../index')
        const codexHome = await createCodexHome([{
            id: 'session-with-message',
            cwd: path.join(tmpdir(), 'project'),
            message: 'Hello from Codex',
            timestamp: '2026-07-15T03:00:00.000Z',
            malformedLine: true,
        }])

        await expect(new CodexProvider({ codexHome }).getSessionFirstMessage('session-with-message'))
            .resolves.toBe('Hello from Codex')
    })

    it('reads visible user and assistant history without injected context', async () => {
        const { CodexProvider } = await import('../index')
        const cwd = path.join(tmpdir(), 'project')
        const codexHome = await createCodexHome([{
            id: 'session-history',
            cwd,
            message: 'User question',
            assistantMessage: 'Agent answer',
            timestamp: '2026-07-15T03:00:00.000Z',
            injectedContext: true,
            userEvent: true,
        }])

        const history = await new CodexProvider({ codexHome }).getSessionHistory('session-history', cwd)

        expect(history.map(entry => ({ role: entry.role, text: entry.text }))).toEqual([
            { role: 'user', text: 'User question' },
            { role: 'assistant', text: 'Agent answer' },
        ])
        expect(new Set(history.map(entry => entry.id)).size).toBe(2)
        expect(history[0]?.turnId).toBe(history[1]?.turnId)
    })

    it('uses the semantic user event instead of injected system context', async () => {
        const { CodexProvider } = await import('../index')
        const codexHome = await createCodexHome([{
            id: 'session-with-context',
            cwd: path.join(tmpdir(), 'project'),
            message: 'The actual user prompt',
            responseMessage: 'Fallback response prompt',
            timestamp: '2026-07-15T03:00:00.000Z',
            injectedContext: true,
            userEvent: true,
        }])

        const provider = new CodexProvider({ codexHome })
        const sessions = await provider.listSessions(path.join(tmpdir(), 'project'))

        expect(sessions[0]).toMatchObject({
            title: 'The actual user prompt',
            firstMessage: 'The actual user prompt',
        })
        await expect(provider.getSessionFirstMessage('session-with-context'))
            .resolves.toBe('The actual user prompt')
    })

    it('does not expose subagent rollouts as separate sessions', async () => {
        const { CodexProvider } = await import('../index')
        const cwd = path.join(tmpdir(), 'project')
        const codexHome = await createCodexHome([{
            id: 'main-session',
            cwd,
            message: 'Main task',
            timestamp: '2026-07-15T03:00:00.000Z',
        }, {
            id: 'subagent-rollout',
            sessionId: 'main-session',
            cwd,
            message: 'Delegated turn',
            timestamp: '2026-07-15T04:00:00.000Z',
        }])

        const sessions = await new CodexProvider({ codexHome }).listSessions(cwd)

        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.sessionId).toBe('main-session')
    })

    it('coalesces multiple root rollouts for the same native session', async () => {
        const { CodexProvider } = await import('../index')
        const cwd = path.join(tmpdir(), 'project')
        const codexHome = await createCodexHome([{
            id: 'same-session',
            fileId: 'older-rollout',
            cwd,
            message: 'Older title',
            timestamp: '2030-07-15T03:00:00.000Z',
        }, {
            id: 'same-session',
            fileId: 'newer-rollout',
            cwd,
            message: 'Current title',
            timestamp: '2030-07-15T04:00:00.000Z',
        }])

        const sessions = await new CodexProvider({ codexHome }).listSessions(cwd)

        expect(sessions).toHaveLength(1)
        expect(sessions[0]).toMatchObject({ sessionId: 'same-session', title: 'Current title' })
    })
})

describe('parseCodexModels', () => {
    it('parses visible Codex model catalog entries', () => {
        expect(parseCodexModels(JSON.stringify({
            models: [
                { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
                {
                    slug: 'gpt-5.3-codex',
                    name: 'GPT-5.3 Codex',
                    default_reasoning_level: 'high',
                    supported_reasoning_levels: [
                        { effort: 'medium' },
                        { effort: 'high', description: 'Deep' },
                    ],
                },
                { slug: 'internal', display_name: 'Internal', visibility: 'hidden' },
            ],
        }))).toEqual([
            { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai' },
            {
                id: 'gpt-5.3-codex',
                name: 'GPT-5.3 Codex',
                provider: 'openai',
                defaultReasoningLevel: 'high',
                supportedReasoningLevels: [
                    { effort: 'medium' },
                    { effort: 'high', description: 'Deep' },
                ],
            },
        ])
    })
})

async function createCodexHome(sessions: Array<{
    id: string
    fileId?: string
    sessionId?: string
    cwd: string
    message: string
    timestamp: string
    malformedLine?: boolean
    injectedContext?: boolean
    responseMessage?: string
    assistantMessage?: string
    userEvent?: boolean
}>): Promise<string> {
    const codexHome = await mkdtemp(path.join(tmpdir(), 'codever-codex-'))
    tempDirs.push(codexHome)
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '15')
    await mkdir(sessionDir, { recursive: true })

    for (const session of sessions) {
        const records = [
            JSON.stringify({
                timestamp: session.timestamp,
                type: 'session_meta',
                payload: {
                    id: session.id,
                    session_id: session.sessionId ?? session.id,
                    cwd: session.cwd,
                    timestamp: session.timestamp,
                },
            }),
            ...(session.malformedLine ? ['not-json'] : []),
            ...(session.injectedContext ? [JSON.stringify({
                timestamp: session.timestamp,
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [
                        { type: 'input_text', text: '<recommended_plugins>catalog</recommended_plugins>' },
                        { type: 'input_text', text: '# AGENTS.md instructions for D:\\codever' },
                        { type: 'input_text', text: '<environment_context>context</environment_context>' },
                    ],
                },
            })] : []),
            JSON.stringify({
                timestamp: session.timestamp,
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: session.responseMessage ?? session.message }],
                },
            }),
            ...(session.userEvent ? [JSON.stringify({
                timestamp: session.timestamp,
                type: 'event_msg',
                payload: { type: 'user_message', message: session.message },
            })] : []),
            ...(session.assistantMessage ? [JSON.stringify({
                timestamp: new Date(Date.parse(session.timestamp) + 1_000).toISOString(),
                type: 'event_msg',
                payload: { type: 'agent_message', message: session.assistantMessage },
            })] : []),
        ]
        await writeFile(
            path.join(sessionDir, `rollout-${session.timestamp.replace(/:/g, '-')}-${session.fileId ?? session.id}.jsonl`),
            `${records.join('\n')}\n`,
            'utf-8',
        )
    }
    return codexHome
}
