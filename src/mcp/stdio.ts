/**
 * Codever MCP Server — Stdio entry point
 *
 * Launched as a subprocess by ACP-compatible agents via the mcpServers config.
 * Provides codever environment context via MCP resources and tools.
 *
 * Usage: node dist/mcp/stdio.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerCodeverMcpSurface } from './register'

async function main() {
    const server = new McpServer({
        name: 'codever',
        version: '1.0.0',
    })

    registerCodeverMcpSurface(server)

    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('[codever-mcp] Server started on stdio')
}

main().catch((e) => {
    console.error('[codever-mcp] Fatal:', e)
    process.exit(1)
})
