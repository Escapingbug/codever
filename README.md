# codever

Codever is an ACP-to-Telegram bridge for running coding agents from chat. It runs on your machine, starts ACP-compatible agent subprocesses, and projects the agent conversation into Telegram with tool output, permission prompts, session controls, and Codever MCP context.

The current implementation is a Telegram topic session gateway: each Telegram forum topic can own an independent agent session, while the daemon, config, provider processes, and project files stay local.

## Features

- **Telegram remote agent UI**: send prompts from Telegram and receive assistant text, tool progress, errors, and final status.
- **ACP providers**: supports `opencode acp`, `codebuddy acp`, and Cursor CLI's `agent acp`.
- **Topic-based sessions**: each Telegram topic can map to a separate project/session; the general topic is reserved for control commands.
- **Permission handling**: provider permission requests are shown as Telegram inline buttons.
- **Session controls**: interrupt, reset, archive, list, and resume sessions from Telegram.
- **Provider/model controls**: choose provider, model, permission mode, verbosity, and timeout per group/session.
- **Codever MCP surface**: agents can read Codever environment resources and use tools such as reminders and proactive messages.
- **Local-only runtime**: no hosted backend; the daemon uses Telegram long polling and stores state under your home directory.

## Requirements

- Node.js 20 or newer.
- pnpm.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- At least one supported provider command available in `PATH`:
  - `opencode` with `opencode acp`;
  - `codebuddy` with `codebuddy acp`;
  - `agent` with `agent acp` for Cursor CLI Agent.

## Installation

Codever is currently used from source.

```bash
git clone git@github.com:Escapingbug/codever.git
cd codever
pnpm install
pnpm build
```

To make the `codever` and `codever-mcp` commands available globally from this checkout:

```bash
pnpm link --global
```

For development without a global link, use:

```bash
pnpm dev -- <command>
```

For example:

```bash
pnpm dev -- status
```

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Run `/newbot` and follow the prompts.
3. Copy the bot token.
4. If you want to use forum topics as separate sessions, create or use a Telegram supergroup with topics enabled.

### 2. Configure Codever

```bash
codever config set-bot-token <your-bot-token>
```

Optional, for the test observer bot:

```bash
codever config set-test-bot-token <your-test-bot-token>
```

### 3. Start the Daemon

```bash
codever start
```

The daemon starts in the background, initializes available providers, starts the local MCP/daemon API plumbing, and begins Telegram long polling.

Check status and logs with:

```bash
codever status
codever logs
codever logs -f
```

### 4. Pair Your Telegram Account

1. Open a DM with your bot.
2. Send `/start`.
3. The bot replies with a short code.
4. Run the pairing command locally:

```bash
codever pair <code>
```

After pairing, add the bot to a Telegram group. Send prompts from a topic to interact with an agent.

## Usage

### Basic Workflow

1. Add the bot to a Telegram group.
2. Create or open a forum topic for the task.
3. Set the project directory in that group/topic:

```text
/cwd /path/to/project
```

4. Send a normal Telegram message. Codever starts or resumes the topic's agent session.
5. Use inline buttons for permission prompts when the provider asks for tool approval.

If you send a non-command message in the general topic, Codever asks you to use a real topic. The general topic is intended for control commands such as `/help` and `/provider`.

### Telegram DM Commands

| Command | Description |
|---------|-------------|
| `/start` | Pair this Telegram account or show pairing status. |
| `/status` | Show active sessions. |
| `/provider` | Set the default provider for new sessions. |
| `/restart` | Restart the daemon. |
| `/help` | Show DM help. |

### Telegram Group Commands

| Command | Description |
|---------|-------------|
| `/cwd <path>` | Set the working directory. `~` is expanded; missing paths can be created through a confirmation button. |
| `/provider` | Choose the provider. In the general topic it changes new-session defaults; inside a topic it targets that session. |
| `/model [name]` | Choose or set the provider model. |
| `/mode` | Choose permission mode. Provider modes are shown with Codever modes such as `approve-reads`, `approve-all`, and `deny-all`. |
| `/verbose [0|1|2]` | Set output verbosity: quiet, normal, or verbose. |
| `/timeout [seconds]` | Set query timeout from 10 to 600 seconds. |
| `/config` | Show session/group config. `/config timeout=120` updates timeout. |
| `/stop` | Interrupt the current query while preserving the session. |
| `/progress` | Ask the active provider/session for progress, when supported. |
| `/file [id]` | Request file details from the active provider/session, when supported. |
| `/new` or `/reset` | Clear the current topic conversation and start fresh. |
| `/session`, `/sessions`, `/session_list` | List resumable sessions for the current provider/project. |
| `/resume [id]` | Resume a listed session. Without an id, shows the session list. |
| `/tables` | Return raw markdown for tables that were rendered as Telegram images since your last message. |
| `/archive` | Stop and archive the current topic session. |
| `/restart` | Restart the daemon. |
| `/help` | Show group help and provider-specific commands when available. |

### Provider Notes

Codever registers three provider names:

| Provider | Command | Notes |
|----------|---------|-------|
| `opencode` | `opencode acp` | Default provider unless changed in config. Also uses `opencode models` and `opencode session list --format json` for model/session lists. |
| `codebuddy` | `codebuddy acp` | ACP-based Codebuddy integration. |
| `agent` | `agent acp` | Cursor CLI Agent integration. Uses `agent models` for model discovery and maps Cursor ACP extensions such as plans, questions, todos, tasks, and images into Codever events. |

Providers are initialized when the daemon starts. A provider that is missing or misconfigured is marked not ready, but other providers can still be used.

### MCP Tools And Resources

Codever automatically exposes a local MCP server named `codever` to ACP sessions. Agents can inspect:

- `codever://environment`
- `codever://rendering`
- `codever://commands`
- `codever://channel`

The MCP tool surface includes:

- `get_codever_context`
- `schedule_reminder`
- `cancel_reminder`
- `send_message`
- `send_file`

`send_file` can send raw file attachments with `type=document`/`file`, render local markdown with `type=markdown`, render source files as fenced code blocks with `type=code`, or send images as Telegram photos with `type=image`.

Session-scoped tools such as reminders and proactive messages require an established Codever conversation id. Some providers only make these available after the first completed turn.

## CLI Reference

```text
codever start                         Start the daemon
codever stop                          Stop the daemon
codever restart                       Restart the daemon
codever status                        Show daemon and config status
codever logs [-f]                     Show daemon logs
codever logs --groups                 List group log directories
codever logs --group <chatId>         Show logs for a specific group
codever pair <code>                   Complete Telegram pairing
codever testbot [--log-dir <dir>]     Start the test listener bot
codever config set-bot-token <token>  Configure Telegram bot token
codever config set-test-bot-token <t> Configure test bot token
codever config show                   Show stored configuration summary
```

## Configuration And Data

Runtime state is stored under:

```text
~/.config/codever
```

Important files and directories include:

| Path | Description |
|------|-------------|
| `daemon.pid` | Background daemon PID. |
| `daemon.api.port` | Local API port used by MCP subprocesses. |
| `logs/daemon/global.log` | Global daemon log. |
| `logs/daemon/groups/` | Per-group session logs. |

The config store tracks values such as bot tokens, paired Telegram users, group settings, topic state, default provider, and scheduled tasks.

## Architecture

Codever is built around a semantic runtime:

```text
Telegram handlers   -> route commands, callbacks, and topic messages
SessionManager      -> owns topic/session lookup and persisted group state
TopicSession        -> wires one Telegram topic to one runtime session
Semantic Runtime    -> runs turns, cancellation, commands, and finalization
Provider Adapter    -> normalizes ACP/provider events into ConversationEvent
Channel Projector   -> converts ConversationEvent into ChannelMessage
Delivery Outbox     -> serializes Telegram send/edit operations
TelegramPort        -> implements ChannelPort for Telegram API details
MCP Layer           -> exposes Codever resources and tools to agents
Provider Layer      -> ACP providers: opencode, codebuddy, agent
```

See [docs/architecture.md](docs/architecture.md) for the full current design.

## Development

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:unit
pnpm test:e2e
```

Run from source:

```bash
pnpm dev -- <command>
```

Examples:

```bash
pnpm dev -- start
pnpm dev -- status
pnpm dev -- logs -f
```
