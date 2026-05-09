/**
 * MCP Resources & Tools — Codever environment context
 *
 * Provides agents with information about the codever bridge environment
 * via MCP resources (pull-based) and tools (on-demand).
 *
 * Resources:
 *   codever://environment  — General environment overview
 *   codever://rendering    — Output rendering rules (table images, markers)
 *   codever://commands     — User-facing commands available in the channel
 *   codever://channel      — Channel constraints and capabilities
 */

import { z } from 'zod'

// ─── Resource content ────────────────────────────────────────────────────────

const RESOURCES: Record<string, { uri: string; name: string; description: string; mimeType: string; content: string }> = {
    environment: {
        uri: 'codever://environment',
        name: 'Codever Environment',
        description: 'Overview of the Codever bridge environment the agent is running in',
        mimeType: 'text/markdown',
        content: `# Codever Environment

You are running inside a **Codever** environment — a bridge that connects you to a remote user via a messaging channel (currently Telegram).

## What This Means

- You are **not** interacting with the user through a local TUI. The user is communicating with you through a Telegram chat.
- Your text output is sent as messages to the Telegram chat. Long outputs may be split into multiple messages.
- You have access to MCP tools provided by codever (see other resources for details).
- The user may be on a mobile device — prefer well-structured, readable output.

## Key Differences from Local TUI

- **No interactive prompts** — permission requests appear as inline buttons in Telegram
- **No terminal rendering** — your output is converted to Telegram-compatible format
- **Asynchronous** — the user may not respond immediately to permission prompts

Use the other codever resources to learn about specific aspects:
- \`codever://rendering\` — How your output is rendered for the channel
- \`codever://commands\` — Commands the user can use
- \`codever://channel\` — Channel constraints and capabilities
`,
    },
    rendering: {
        uri: 'codever://rendering',
        name: 'Codever Rendering Rules',
        description: 'How agent output is rendered in the messaging channel, including table image conversion and special markers',
        mimeType: 'text/markdown',
        content: `# Rendering Rules

Codever transforms your markdown output before sending it to the messaging channel. Understanding these rules helps you produce better-looking output.

## Table Rendering

Markdown tables are **automatically converted to PNG images** for display in Telegram. This produces much better visual results than raw pipe-delimited text.

### Disabling Table Image Rendering

If you want a table to be sent as **raw text** instead of an image, add an HTML comment \`<!-- raw -->\` on the line immediately before the table:

\`\`\`markdown
<!-- raw -->
| Column | Value |
|--------|-------|
| A      | 1     |
\`\`\`

Use \`<!-- raw -->\` when:
- The table is very small (2-3 cells) and an image would be overkill
- The user needs to copy table content as text
- The table is part of a larger text block where an image would break the flow

### Normal rendering (default — no marker needed):

\`\`\`markdown
| Status | Component | Details |
|--------|-----------|---------|
| ✅     | Pipeline  | Working |
\`\`\`

This will be rendered as a styled image.

## Text Formatting

- **Bold**, *italic*, and \`inline code\` are supported via Telegram entities
- Code blocks (\`\`\`) are rendered with syntax highlighting when possible
- Headings are rendered as bold text
- Lists are rendered with proper indentation

## Message Splitting

Long outputs are split at structure-safe boundaries (paragraph breaks, heading boundaries) to fit Telegram's message length limits. You do not need to worry about message length — just write naturally.
`,
    },
    commands: {
        uri: 'codever://commands',
        name: 'Codever User Commands',
        description: 'Commands available to the user in the messaging channel',
        mimeType: 'text/markdown',
        content: `# User Commands

The user has access to these commands in the Telegram chat. You cannot invoke these — they are for the user only. But you should know they exist.

| Command | Description |
|---------|-------------|
| \`/cwd &lt;path&gt;\` | Set working directory for the session |
| \`/stop\` | Interrupt the current query |
| \`/new\` or \`/reset\` | Reset session (start fresh conversation) |
| \`/archive\` | Archive the current session |
| \`/tables\` | View raw markdown of tables rendered as images in this session |
| \`/config key=value\` | Change session settings (e.g., timeout) |
| \`/restart\` | Restart the codever daemon |

## Notes

- \`/stop\` interrupts your current work — the user will see whatever output you have produced so far
- \`/new\` resets the conversation — your next interaction starts from scratch
- \`/tables\` lets the user retrieve the original markdown of tables that were rendered as images
`,
    },
    channel: {
        uri: 'codever://channel',
        name: 'Codever Channel Capabilities',
        description: 'Constraints and capabilities of the messaging channel (Telegram)',
        mimeType: 'text/markdown',
        content: `# Channel: Telegram

## Capabilities

- **Text messages** with markdown formatting (bold, italic, code, code blocks)
- **Entity-based rendering** — text styling is done via Telegram entities, not HTML
- **Table images** — markdown tables are rendered as PNG images for better readability
- **Inline keyboards** — used for permission prompts and decisions
- **Topics (forum threads)** — each topic in a supergroup can have its own independent session

## Constraints

- **Message length**: ~4096 UTF-16 characters per message. Long outputs are automatically split.
- **No real-time streaming** — output is sent in chunks as you produce it, but not character-by-character
- **Limited markdown** — Telegram supports a subset of markdown. Complex markdown (nested lists, definition lists) may not render perfectly
- **No file attachments** — you cannot directly send files to the user through the channel. Use your coding tools to write files to disk instead
- **Rate limits** — Telegram has rate limits on message sending. Very rapid output may be slightly delayed

## Tips for Better Output

- Prefer **shorter, well-structured** responses over very long ones
- Use **tables** for structured data — they render beautifully as images
- Use \`<!-- raw -->\` before tables when the user needs to copy the content
- **Code blocks** with language tags get syntax highlighting
- Avoid extremely deep nesting — Telegram's rendering flattens some structures
`,
    },
}

// ─── Register MCP Resources ──────────────────────────────────────────────────

export function registerContextResources(server: any): void {
    // Register the resource templates
    for (const res of Object.values(RESOURCES)) {
        server.resource(
            res.name,
            res.uri,
            res.description,
            async () => ({
                contents: [{
                    uri: res.uri,
                    mimeType: res.mimeType,
                    text: res.content,
                }],
            }),
        )
    }
}

// ─── Register MCP Tools ──────────────────────────────────────────────────────

export function registerContextTools(server: any): void {
    server.tool(
        'get_codever_context',
        'Get information about the Codever bridge environment. Use this to learn about rendering rules, available commands, and channel capabilities. Call with a specific topic or without arguments for an overview.',
        {
            topic: z.enum(['environment', 'rendering', 'commands', 'channel'])
                .optional()
                .describe('Which aspect of the codever environment to learn about. Omit for a brief overview of all topics.'),
        },
        async (args: { topic?: string }) => {
            if (args.topic && RESOURCES[args.topic]) {
                const res = RESOURCES[args.topic]
                return {
                    content: [{ type: 'text' as const, text: res.content }],
                }
            }

            // No topic — return overview with available topics
            const overview = `# Codever Context Overview

You are running in a **Codever** environment — a bridge connecting you to a remote user via Telegram.

## Available Topics

Call \`get_codever_context\` with one of these topics to learn more:

- **environment** — General overview of the Codever bridge environment
- **rendering** — How your output is rendered (table images, \`<!-- raw -->\` marker, formatting)
- **commands** — Commands available to the user (/stop, /new, /tables, etc.)
- **channel** — Telegram channel constraints and capabilities

## Quick Reference

- Tables are auto-converted to PNG images. Add \`<!-- raw -->\` before a table to send as text instead.
- User commands: /cwd, /stop, /new, /archive, /tables, /config, /restart
- Messages are split at ~4096 chars at structure-safe boundaries.
`

            return {
                content: [{ type: 'text' as const, text: overview }],
            }
        },
    )
}
