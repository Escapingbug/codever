/**
 * MCP Server — Entry point for codever's MCP server.
 * 
 * Exposed to agents via the ACP mcpServers parameter.
 * The agent discovers codever's tools automatically.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerNotifyTools } from './tools/notify'
import { registerSessionTools, type SessionToolContext } from './tools/session'

export interface McpServerContext extends SessionToolContext {}

export function createCodeverMcpServer(ctx: McpServerContext): McpServer {
    const server = new McpServer({
        name: 'codever',
        version: '1.0.0',
    })

    registerNotifyTools(server)
    registerSessionTools(server, ctx)

    return server
}

export async function startCodeverMcpServer(ctx: McpServerContext): Promise<void> {
    const server = createCodeverMcpServer(ctx)
    const transport = new StdioServerTransport()
    await server.connect(transport)
}
