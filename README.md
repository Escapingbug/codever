# codever

ACP ↔ Channel Bridge. Connect ACP-compatible coding agents to Telegram (and future channels), faithfully replicating the local TUI experience remotely. Agents can also interact with codever itself via MCP tools for proactive messaging, self-awareness, and management.

## Features

- **Remote TUI**: Full local TUI experience over Telegram — text, tool calls, permissions, everything
- **ACP Protocol**: Works with any ACP-compatible agent (opencode, codebuddy)
- **Permission handling**: Approve/deny agent tool use via Telegram inline keyboards
- **Multi-provider**: Switch between opencode, codebuddy per session
- **Session management**: Resume past sessions, list history, switch providers
- **MCP tools**: Agents can schedule reminders, manage sessions, and interact with codever
- **No backend server**: Runs entirely on your machine using Telegram long polling

## Prerequisites

- Node.js >= 20
- pnpm
- At least one ACP-compatible agent (opencode or codebuddy) in PATH
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))

## Installation

```bash
# Clone the repo
git clone git@github.com:Escapingbug/codever.git
cd codever

# Install dependencies
pnpm install

# Build
pnpm build

# Link globally (optional)
pnpm link --global
```

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Run `/newbot` and follow the prompts
3. Copy the bot token

### 2. Configure the Bot Token

```bash
codever config set-bot-token <your-bot-token>
```

### 3. Pair Your Telegram Account

1. Open a DM with your bot on Telegram
2. Send `/pair` — the bot will reply with a pairing code
3. Run the following in your terminal:

```bash
codever pair <code>
```

### 4. Verify Setup

```bash
codever status
```

## Usage

### Start the Daemon

```bash
codever start
```

This starts the codever daemon in the background. The Telegram bot begins polling for messages.

### Basic Workflow

1. Create a Telegram group and add your bot
2. Set the working directory: `/cwd /path/to/your/project`
3. Send a message — the coding agent will respond in the group
4. Use `/stop` to cancel, `/new` to reset, `/model` to switch models

### Commands

| Command | Description |
|---------|-------------|
| `/cwd <path>` | Set working directory |
| `/model <name>` | Switch model |
| `/mode <mode>` | Switch permission mode (approve-all, approve-reads, deny-all) |
| `/stop` | Cancel current query |
| `/new` | Reset session and start fresh |
| `/archive` | Archive the group session |
| `/resume <id>` | Resume a specific session |
| `/session` | List available sessions |
| `/provider <name>` | Switch provider (opencode, codebuddy) |
| `/config` | Show current configuration |
| `/verbose <level>` | Set output verbosity |
| `/restart` | Restart the daemon |

## CLI Reference

```
codever start                     Start the daemon
codever stop                      Stop the daemon
codever restart                   Restart the daemon
codever status                    Show daemon status
codever logs                      Show daemon logs
codever pair <code>               Complete Telegram pairing
codever config set-bot-token <t>  Set Telegram bot token
codever config show               Show current configuration
```

## Architecture

Codever is an ACP ↔ Channel Bridge with structure-aware output processing:

```
Channel Layer       — Telegram / Discord / CLI (replaceable, implements ChannelPort)
Bridge Layer        — SessionBridge (wiring) + SessionManager (lifecycle) + ChannelPort interface
Core Layer          — CoreSession state machine + EventBus + Scheduler (~600 LOC)
Middleware Layer    — Structure-aware Pipeline + Formatting + Timeout
MCP Layer           — MCP server exposed to agent via ACP mcpServers param
Provider Layer      — AcpProvider base → OpencodeProvider / CodebuddyProvider
```

See [docs/architecture.md](docs/architecture.md) for the full design document.

## Development

```bash
# Type check
pnpm typecheck

# Build
pnpm build

# Run tests
pnpm test

# Run from source (no build needed)
pnpm dev
```

Set `DEBUG=1` for verbose logging:

```bash
DEBUG=1 codever start
```

## Configuration

Config is stored at `~/.config/codever-nodejs/` (managed by the `conf` package).

| Key | Description |
|-----|-------------|
| `botToken` | Telegram bot token |
| `pairedUsers` | Authorized Telegram user IDs and their DM chat IDs |
| `pairedChats` | Authorized group chat IDs |
