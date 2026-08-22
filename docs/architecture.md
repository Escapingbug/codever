# Codever Architecture

## 1. Current Shape

Codever is an **ACP to Channel bridge**. It connects ACP-compatible coding agents to messaging channels, currently Telegram, and exposes Codever-specific MCP tools back to the running agent.

The current implementation is a **Telegram Topic Session Gateway with a Semantic Runtime**:

```text
Telegram update
  -> Telegram handlers
  -> SessionManager
  -> TopicSession
  -> SemanticSessionRuntime
  -> AgentProvider / ACP
  -> ProviderSemanticAdapter
  -> ConversationEvent
  -> ChannelProjector
  -> DeliveryOutbox
  -> TelegramPort
```

This is the active architecture.

## 2. Design Principles

1. **Bridge, not orchestrator**: Codever connects one channel session to one provider session. It does not implement multi-agent supervision.
2. **Semantic events are the internal contract**: provider-specific `AgentEvent` values are normalized into `ConversationEvent` before rendering.
3. **Runtime owns turn lifecycle**: `SemanticSessionRuntime` owns query/cancel/finalize behavior for a topic session.
4. **Channel delivery is isolated**: `ChannelProjector` decides what should be shown, while `DeliveryOutbox` serializes send/edit operations.
5. **Telegram details stay behind ChannelPort**: message sending, editing, table rendering, topic routing, and inline keyboards are channel responsibilities.
6. **MCP is an extension boundary**: agents interact with Codever through MCP tools and resources, not hidden provider-specific protocols.
7. **Session wrappers are optional and local**: administrator-installed session
   extensions may wrap provider input and presented semantic events. With no
   binding the runtime is a pass-through; extension-specific models, secrets,
   mappings, storage, declarative view contents, and action semantics stay
   outside the core. Project bindings are defaults for new sessions, not live
   policy inherited by existing sessions.

## 3. Runtime Flow

### 3.1 User Message

```text
Telegram message
  -> channel/telegram/handlers/messageRouter.ts
  -> find or create TopicSession for chat/topic
  -> TopicSession.receiveInput()
  -> SemanticSessionRuntime.dispatch({ kind: "user_message" })
  -> optional SessionExtensionHost.prepareTurn()
  -> AgentProvider.startQuery()
  -> ACP events stream back
  -> ProviderSemanticAdapter.toConversationEvents()
  -> canonical ConversationEvent journal
  -> optional SessionExtensionHost.presentEvent()
  -> ChannelProjector.project()
  -> DeliveryOutbox.send/edit()
  -> TelegramPort.send/edit()
```

### 3.2 Tool Display

ACP providers emit tool start/update/result events in provider-specific shapes. The runtime normalizes them into `ConversationEvent` values with stable `toolCallId`, `phase`, `toolName`, input, output, and optional structured content.

`ChannelProjector` merges tool updates and produces channel messages. If the channel supports editing, `DeliveryOutbox` edits the existing tool message; otherwise it can fall back to sending a replacement.

### 3.3 Permission Flow

Permission requests are handled at provider/runtime boundaries:

```text
Provider permission request
  -> SemanticSessionRuntime.createPermissionHandler()
  -> ChannelPort.requestDecision()
  -> Telegram inline keyboard
  -> Telegram callback handler
  -> TopicSession.dispatch({ kind: "decision_response" })
  -> provider receives allow/deny
```

Permission UI is a channel concern. Runtime records the decision event and bridges the result back to the provider.

### 3.4 Scheduled and MCP Messages

The daemon hosts a local HTTP API for MCP subprocesses. MCP tools use this API because the MCP server runs in a separate process.

```text
Agent MCP tool call
  -> mcp/stdio.ts
  -> mcp/tools/*
  -> daemon/api.ts
  -> Scheduler or SessionManager
  -> TopicSession.receiveInput()
  -> SemanticSessionRuntime
```

Scheduled reminders and immediate send-message requests are injected into the same topic-session runtime path as user messages.

### 3.5 Matrix Gateway Local Administration

The Matrix/PWA Gateway exposes host-owner management over a Unix domain socket,
not a TCP port:

```text
codever gateway ...
  -> GatewayAdminClient
  -> owner-only admin socket
  -> invitation/device administration OR workspace file inbox
```

The authenticated-PWA `device.invite` operation and the local admin API use the
same `DeviceInvitationCoordinator`. The running Gateway process supplies its
current Matrix transport binding, so an external helper cannot accidentally
sign an invitation for a stale Matrix device. Long-lived Matrix access tokens
remain server-side and may only be exchanged for short-lived one-time device
login tokens.

`codever send-file <path>` uses the same owner-only socket, but enters a
workspace-level file inbox instead of resolving a session. The Gateway reads
the caller-selected local file, encrypts and uploads the media, and durably
stages an `inbox.file.received` event without a `sessionId`. The selected PWA
conversation is never used as an implicit routing signal.

### 3.6 Remote Privileged Execution

The Matrix/PWA runtime may expose `privileged_exec` when a root Helper was
installed on the Gateway host. The MCP subprocess calls the owner-only Gateway
admin socket with its Codever session ID. The Gateway calls the active
`TopicSession` directly, rather than entering the runtime mailbox behind the
currently blocked provider turn. `SemanticSessionRuntime` accepts the request
only while that turn is `querying` and owns its one-shot, TOTP-backed approval.

```text
Agent MCP subprocess
  -> Gateway admin socket
  -> active TopicSession / SemanticSessionRuntime
  -> MatrixCvp3Port privilege decision
  -> PWA device with privilege.approve
  -> WebAuthn device unlock + client-side TOTP
  -> UnixSocketPrivilegeExecutor
  -> root-owned Privilege Helper
```

The root Helper is a separate systemd service or macOS LaunchDaemon. It does
not parse shell command strings: it executes one absolute executable with an
argument vector and minimal environment. A root-owned policy constrains
executable paths; request expiry, durable replay claims, timeouts, and bounded
output are enforced again at the privilege boundary. The local Gateway account
and Helper credential do not contain the TOTP setup key; every execution also
requires a fresh code that the Helper validates and claims once. See
`docs/privileged-execution.md`.

### 3.7 Codever Protocol v3 (CVP/3) over Matrix

Matrix is the durable conversation log, not a per-device mailbox or RPC queue.
One encrypted room is one project and every session is an `m.thread`. User
commands and Gateway outputs are ordinary `m.room.message` events carrying a
signed, application-encrypted CVP/3 envelope. Stable logical IDs are independent
from Matrix physical event IDs; `causationCommandId` links an output to a
command without making the two messages the same entity.

CVP/3 distinguishes business scope from its Matrix transport route. A
`session.create` command with `scope: scratch` receives an isolated
Gateway-owned working directory and is projected under the workspace's
Temporary group rather than a project group. Workspace inbox events have no
session ID; active project rooms remain only their encrypted carriers until a
dedicated workspace carrier is introduced. Inbox events are replicated once
per project room that currently has an authorized device, so the workspace
list is reachable without inferring a conversation or session.

The PWA exposes provider history independently from new-session creation.
`provider.sessions.list` and `provider.session.inspect` use each provider's
session-list/load capabilities to browse a bounded read-only preview. Sending
from that preview creates a new Codever session bound to the existing
`providerSessionId`; an already active binding opens the managed session.
Provider selection is fixed by `session.create`. Project defaults cover model
and reasoning for later sessions, while live model/reasoning changes use ACP's
structured session model/config APIs. Provider-published
`available_commands_update` values are projected as a PWA command palette, and
the resulting slash text remains an ordinary provider prompt.

Archive is the only Codever removal lifecycle. It removes the session from the
managed projection without deleting Matrix or provider-owned history. Legacy
delete input aliases archive, restore is rejected, and continuation happens
through Provider History with a new Codever session identity.

The Gateway persists the exact outbound content and stable Matrix transaction
ID before sending. It also journals every accepted command ID before execution,
so Matrix retry, restart, and multi-device redelivery cannot execute a command
twice. Ordinary conversation events are room broadcasts and do not multiply
with device count. Only project key grants, pairing messages, and Gateway
transport rotation are pairwise device control.

Current project state is an ordinary signed snapshot event referenced by
`io.codever.project.current.v3`. Clients rebuild by verifying that pointer,
fully paginating Matrix threads, and loading selected thread relations. They
persist raw events before projection, quarantine poison per event, and retry
dependency-deferred records in multiple passes. The `/sync` token is only an
availability cursor; it is never application authority or a manual checkpoint.

Android owns sync, inbox projection, command reconciliation, and notification
inside its foreground connection service. The WebView is a replaceable UI and
does not need to remain attached for Agent output to converge. Production
Gateway, PWA, and APK entry points accept only the CVP/3 application data plane;
the independently versioned pairing and device-rotation control plane is the
only pre-CVP/3 mechanism retained. See
`docs/codever-protocol.md`.

## 4. Main Components

### 4.1 `daemon.ts`

The composition root. It registers providers, loads persisted config, starts the scheduler, starts the daemon API, creates the Telegram bot, and shuts down active topic sessions gracefully.

### 4.2 Telegram Handlers

Current handlers live under `src/channel/telegram/handlers/` and are registered from `src/channel/telegram/bot.ts`.

Responsibilities:

- pair and authorize users;
- handle group commands such as `/cwd`, `/new`, `/stop`, `/provider`, `/resume`, `/verbose`, `/timeout`;
- route Telegram messages to the correct topic session;
- route callback queries back into the session runtime.

Telegram channel ownership is now consolidated under `src/channel/telegram`.

### 4.3 `SessionManager`

`SessionManager` is the runtime registry for group/topic state:

- group CWD and settings;
- topic key normalization;
- active `TopicSession` map;
- `SessionRecord` lookup maps;
- provider switch bookkeeping;
- archived topic and cooldown state.

It should remain the single place that answers "which runtime session belongs to this channel topic?"

### 4.4 `TopicSession`

`TopicSession` is the bridge object for a Telegram topic. It wraps:

- a `SessionRecord` metadata record;
- a session-scoped provider instance;
- a `ChannelPort`;
- a `SemanticSessionRuntime`.

`TopicSession.receiveInput()` is the public entry point for user/system messages. `TopicSession.dispatch()` is used for semantic inputs such as commands, cancel requests, and decision responses.

### 4.5 `SemanticSessionRuntime`

`SemanticSessionRuntime` is the execution core.

Responsibilities:

- serialize inputs with a mailbox;
- run provider turns;
- track runtime state: `idle`, `querying`, `canceling`, `finalizing`, `dead`;
- start, cancel, and finalize provider queries;
- create permission handlers;
- record a `ConversationJournal`;
- convert provider events into semantic events;
- project and deliver channel messages;
- handle runtime commands such as model/provider/session changes.

This is the main runtime. New lifecycle behavior should usually be implemented here, not in metadata records.

An optional `SessionExtensionHost` belongs to the runtime boundary. It composes
session-bound extensions around a turn, pauses through a bounded declarative
interaction surface, journals provider events before display transformation,
and fails closed if a bound extension is unavailable. The extension owns the
view contents and interprets returned action IDs. The Matrix Gateway registry
is administrator-owned; remote PWA commands can select an advertised manifest
but cannot register code, an endpoint, or a secret. A project stores a default
binding template; a new session snapshots it, and an explicit later session
change recreates the runtime and provider conversation. See
`docs/session-extensions.md`.

### 4.6 `SessionRecord`

`SessionRecord` is the lightweight metadata record attached to a topic session.

Current role:

- stores session identity and settings used by handlers;
- exposes `groupChatId`, `messageThreadId`, `conversationId`, provider name, model, verbose level, timeout, provider settings, and provider commands;
- emits session lifecycle events used by manager cleanup paths.

There is no separate session loop in the active architecture.

### 4.7 `ProviderSemanticAdapter`

Provider adapters translate provider-level `AgentEvent` streams into Codever's internal `ConversationEvent` model.

This layer absorbs provider-specific quirks, including:

- tool call patch/update shapes;
- missing or generic tool names;
- structured content blocks;
- replayed history from ACP `loadSession`;
- provider command/config updates.

ACP extension methods keep the same ownership boundary. The shared ACP client manager only exposes generic `extMethod` and `extNotification` hooks; it must not encode provider-specific method names. Provider-specific extensions are registered by the concrete provider. For Cursor's `agent acp` provider, `src/providers/agent/cursorExtensions.ts` owns all `cursor/*` parsing and maps it to existing Codever surfaces:

- `cursor/create_plan` uses the runtime decision handler for plan approval and renders Cursor todos through `TodoWrite`.
- `cursor/ask_question` uses the runtime decision handler and returns Cursor's selected option response shape.
- `cursor/update_todos`, `cursor/task`, and `cursor/generate_image` are notifications rendered as existing tool/text events.

If another ACP provider adds extension methods, implement its mapping under that provider directory rather than adding provider-specific cases to `runtime/providerAdapter.ts`, `ChannelProjector`, or the shared ACP client.

### 4.8 `ChannelProjector`

`ChannelProjector` converts semantic events into `ChannelMessage` values.

Responsibilities:

- buffer assistant text until a flush boundary;
- merge tool updates by `toolCallId`;
- format tool bubbles;
- suppress internal command/config update noise;
- produce status/error messages for completed, cancelled, or failed turns.

The projector should stay channel-aware only through `ChannelMessage`, not through Telegram API calls.

### 4.9 `DeliveryOutbox`

`DeliveryOutbox` serializes channel delivery.

Responsibilities:

- order send/edit operations;
- retry Telegram rate-limit errors;
- distinguish delayed confirmation (`queued`) from a final delivery failure;
- observe late confirmations without issuing a duplicate resend;
- fall back from edit to send when appropriate;
- record delivery failures for debugging.

### 4.10 `TelegramPort`

`TelegramPort` implements `ChannelPort` for Telegram.

Responsibilities:

- send markdown/html/plain messages;
- edit existing messages for progressive tool display;
- render markdown tables as images;
- keep table history for `/tables`;
- send chat actions;
- request user decisions through inline keyboards.

### 4.11 MCP Layer

The active MCP stdio entry is `src/mcp/stdio.ts`. It registers:

- context resources/tools from `src/mcp/resources.ts`;
- notify tools from `src/mcp/tools/notify.ts`;
- `privileged_exec` from `src/mcp/tools/privilege.ts` when the Matrix Gateway
  has an installed Privilege Helper.

Shared registration lives in `src/mcp/register.ts`; session tools from `src/mcp/tools/session.ts` are registered only when a daemon/runtime context provides a `SessionToolContext`.

## 5. Directory Map

```text
src/
  daemon.ts                         # composition root
  config.ts                         # persistent config and topic state

  bridge/
    channelPort.ts                  # ChannelPort and TopicSession interfaces
    sessionManager.ts               # session registry and persisted group/topic state
    topicSession.ts                 # Telegram topic -> SemanticSessionRuntime bridge

  runtime/
    semantic.ts                     # SessionInput and ConversationEvent model
    semanticSessionRuntime.ts       # active execution runtime
    providerAdapter.ts              # AgentEvent -> ConversationEvent
    channelProjector.ts             # ConversationEvent -> ChannelMessage
    deliveryOutbox.ts               # serialized send/edit delivery

  channel/
    telegram/
      bot.ts                        # bot factory, registers handlers
      telegramPort.ts               # ChannelPort implementation
      pairing.ts                    # user pairing
      toolBubble.ts                 # tool bubble HTML formatting
      handlers/                     # active Telegram command/callback/message handlers
      keyboard.ts                   # Telegram inline keyboard builders
      renderer.ts                   # markdown/html Telegram renderer

  providers/
    provider.ts                     # AgentProvider interface
    types.ts                        # AgentEvent model
    registry.ts                     # provider catalog and per-session factories
    configured.ts                   # provider profile config loading and registration
    acp/                            # shared ACP implementation
    opencode/                       # opencode provider
    codebuddy/                      # codebuddy provider
    agent/                          # Cursor agent ACP provider

  mcp/
    stdio.ts                        # active MCP stdio server entry
    register.ts                     # shared MCP surface registration
    resources.ts                    # codever context resources/tools
    tools/                          # notify/session tools

  core/
    scheduler.ts                    # timed tasks
    eventBus.ts                     # session lifecycle events
    types.ts                        # session event/state types

```

## 6. Persistence Notes

Topic-level state is the only active session persistence model. Group state stores shared channel settings such as cwd, model, provider, permission mode, verbosity, and timeout defaults.

Matrix Gateway security stores use atomic replacement plus a cross-process lock
whose owner records both PID and OS process-start identity. A clean exit removes
only its own token. After an unclean exit, a replacement process reclaims the
lock only when that exact owner no longer exists; elapsed wall-clock time never
steals a live process's security lock. Android persists its Matrix `/sync`
cursor and limited-gap journal under the account-scoped encrypted store.

PWA, APK, Matrix-account, and Gateway schema changes use classified, adjacent,
crash-resumable migrations before their runtime is unlocked. Security and
command state is preserved on an unsupported upgrade; projections and UI
preferences may be rebuilt. The catalogs and mandatory release validation are
defined in [`state-upgrades.md`](./state-upgrades.md).

## 7. Current Ownership

The current ownership chain is:

```text
Telegram handlers
  -> SessionManager
  -> TopicSession
  -> SemanticSessionRuntime
  -> AgentProvider
  -> ProviderSemanticAdapter
  -> ChannelProjector
  -> DeliveryOutbox
  -> TelegramPort
```

Component ownership:

- `SessionManager` owns lookup and persistence.
- `TopicSession` owns wiring.
- `SemanticSessionRuntime` owns lifecycle and commands.
- `ProviderSemanticAdapter` owns provider normalization.
- `ChannelProjector` owns visible message projection.
- `DeliveryOutbox` owns delivery reliability.
- `TelegramPort` owns Telegram API details.

Anything outside this chain should either be a utility or a test helper.

## 8. Stability Invariants

- One Telegram topic maps to one active `TopicSession`.
- One `TopicSession` owns one session-scoped provider instance.
- Runtime input is serialized through `SemanticSessionRuntime.dispatch()`.
- Provider events are normalized before rendering.
- Tool updates are merged by stable tool call id before editing channel messages.
- Channel sends/edits go through `DeliveryOutbox`.
- Telegram's explicit provider-switch command creates or installs a new provider context and clears incompatible provider session identity; Matrix/PWA sessions instead fix the provider at `session.create`.
- Scheduled and MCP-injected messages use the same runtime path as user messages.
- Telegram-specific behavior does not leak into provider adapters.
- Persistence is topic-level for session state; group state stores shared settings such as cwd/provider/model defaults.
