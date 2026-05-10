/**
 * MCP Session Tools — list_sessions, switch_session, get_codever_status
 * 
 * These tools allow the agent to be self-aware and manage sessions.
 */

import { z } from 'zod'
import type { SessionManager } from '@/bridge/sessionManager'
import type { AgentProvider } from '@/providers/provider'
import type { SessionRecord } from '@/bridge/sessionRecord'

export interface SessionToolContext {
    sessionManager: SessionManager
    getProvider: () => AgentProvider | null
    getCwd: () => string | undefined
    getSession?: () => SessionRecord | undefined
}

export function createListSessionsHandler(ctx: SessionToolContext) {
    return async (_args: Record<string, unknown>) => {
        const provider = ctx.getProvider()
        const cwd = ctx.getCwd()

        if (!provider || !cwd) {
            return {
                content: [{ type: 'text' as const, text: 'No provider or working directory available.' }],
            }
        }

        if (!provider.listSessions) {
            return {
                content: [{ type: 'text' as const, text: `Provider "${provider.name}" does not support listing sessions.` }],
            }
        }

        try {
            const sessions = await provider.listSessions(cwd)
            if (sessions.length === 0) {
                return {
                    content: [{ type: 'text' as const, text: 'No sessions found.' }],
                }
            }

            const lines = sessions.map(s => {
                const shortId = s.sessionId.slice(0, 8)
                const title = s.title ? ` — ${s.title}` : ''
                return `• ${shortId}${title}`
            })
            return {
                content: [{ type: 'text' as const, text: `Available sessions:\n${lines.join('\n')}` }],
            }
        } catch (e) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Error listing sessions: ${e instanceof Error ? e.message : String(e)}` }],
            }
        }
    }
}

export function createSwitchSessionHandler(ctx: SessionToolContext) {
    return async (args: { sessionId: string }) => {
        const session = ctx.getSession?.()
        if (!session) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'No active session. Cannot switch session.' }],
            }
        }

        session.setConversationId(args.sessionId)
        return {
            content: [{
                type: 'text' as const,
                text: `Switched to session ${args.sessionId.slice(0, 8)}. Next message will load this session.`,
            }],
        }
    }
}

export function createGetStatusHandler(ctx: SessionToolContext) {
    return async (_args: Record<string, unknown>) => {
        const session = ctx.getSession?.()
        const cwd = ctx.getCwd()
        const provider = ctx.getProvider()

        if (!session) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `Codever Status: No active session\nCWD: ${cwd ?? 'not set'}\nProvider: ${provider?.name ?? 'none'}`,
                }],
            }
        }

        const lines = [
            `Codever Status:`,
            `  Session: ${session.id.slice(0, 8)}`,
            `  State: ${session.state}`,
            `  Provider: ${session.providerName}`,
            `  Model: ${session.model ?? 'default'}`,
            `  CWD: ${session.cwd}`,
            `  Timeout: ${session.timeoutSeconds}s`,
            `  Verbose: ${['Quiet', 'Normal', 'Verbose'][session.verboseLevel]}`,
            `  Provider Session: ${session.conversationId?.slice(0, 8) ?? 'none'}`,
        ]
        return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
        }
    }
}

/** Register all session tools on an MCP server */
export function registerSessionTools(server: any, ctx: SessionToolContext): void {
    server.tool(
        'list_sessions',
        'List available provider sessions for the current working directory.',
        {},
        createListSessionsHandler(ctx),
    )

    server.tool(
        'switch_session',
        'Switch to a different provider session. The next message will use loadSession with the specified session ID.',
        {
            sessionId: z.string().describe('The provider session ID to switch to'),
        },
        createSwitchSessionHandler(ctx),
    )

    server.tool(
        'get_codever_status',
        'Get the current codever bridge status including session state, provider, model, and working directory.',
        {},
        createGetStatusHandler(ctx),
    )
}
