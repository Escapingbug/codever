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

## 3. Runtime Flow

### 3.1 User Message

```text
Telegram message
  -> channel/telegram/handlers/messageRouter.ts
  -> find or create TopicSession for chat/topic
  -> TopicSession.receiveInput()
  -> SemanticSessionRuntime.dispatch({ kind: "user_message" })
  -> AgentProvider.startQuery()
  -> ACP events stream back
  -> ProviderSemanticAdapter.toConversationEvents()
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
- notify tools from `src/mcp/tools/notify.ts`.

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
- Provider switch creates or installs a new provider context and clears incompatible provider session identity.
- Scheduled and MCP-injected messages use the same runtime path as user messages.
- Telegram-specific behavior does not leak into provider adapters.
- Persistence is topic-level for session state; group state stores shared settings such as cwd/provider/model defaults.

