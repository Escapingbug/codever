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

This is the active architecture. Older design names such as `CoreSession`, `SessionBridge`, and "Pipeline as the main runtime" describe a previous migration target, not the current runtime path.

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
  -> transport/telegram/handlers/messageRouter.ts
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

Current handlers live under `src/transport/telegram/handlers/` and are registered from `src/channel/telegram/bot.ts`.

Responsibilities:

- pair and authorize users;
- handle group commands such as `/cwd`, `/new`, `/stop`, `/provider`, `/resume`, `/verbose`, `/timeout`;
- route Telegram messages to the correct topic session;
- route callback queries back into the session runtime.

The current directory split between `transport/telegram` and `channel/telegram` is a migration artifact. The desired final shape is one Telegram channel package.

### 4.3 `SessionManager`

`SessionManager` is the runtime registry for group/topic state:

- group CWD and settings;
- topic key normalization;
- active `TopicSession` map;
- compatibility `QueryLoop` lookup maps;
- provider switch bookkeeping;
- permission lookup compatibility;
- archived topic and cooldown state.

It should remain the single place that answers "which runtime session belongs to this channel topic?"

### 4.4 `TopicSession`

`TopicSession` is the bridge object for a Telegram topic. It wraps:

- a `QueryLoop` compatibility record;
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

This is the main runtime. New lifecycle behavior should usually be implemented here, not in `QueryLoop`.

### 4.6 `QueryLoop`

`QueryLoop` remains in the codebase but is no longer the primary execution loop for Telegram topic sessions.

Current role:

- stores session identity and settings used by handlers and tests;
- exposes compatibility fields such as `groupChatId`, `messageThreadId`, `conversationId`, provider name, model, verbose level, timeout;
- provides legacy state/event APIs that some tests and manager methods still use.

Target role:

- shrink or rename this into a session metadata object, for example `SessionRecord` or `TopicSessionState`;
- remove runtime responsibilities such as `processInput()`, provider retry, message queueing, and permission waiting from the active path.

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

`src/mcp/server.ts` contains a context-injected server factory used by tests and older code paths. The stdio entry is the one launched by ACP providers through `mcpServers`.

## 5. Directory Map

```text
src/
  daemon.ts                         # composition root
  config.ts                         # persistent config and legacy migration

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
    sessionActor.ts                 # legacy/experimental actor, not active main path

  channel/
    telegram/
      bot.ts                        # bot factory, registers handlers
      telegramPort.ts               # ChannelPort implementation
      pairing.ts                    # user pairing
      agentFormatter.ts             # legacy formatter helpers still used by middleware/tests
      toolBubble.ts                 # tool bubble HTML formatting

  transport/
    telegram/
      handlers/                     # active Telegram command/callback/message handlers
      keyboard.ts                   # Telegram inline keyboard builders
      permissionUI.ts               # older permission helper
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
    resources.ts                    # codever context resources/tools
    tools/                          # notify/session tools
    server.ts                       # context-injected MCP server factory

  core/
    queryLoop.ts                    # compatibility session state, not main runtime
    scheduler.ts                    # timed tasks
    eventBus.ts                     # compatibility events
    types.ts                        # compatibility event/state types

  middleware/
    pipeline.ts                     # legacy/compat pipeline, not the main runtime path
    formatting.ts
    timeout.ts
    structureDetector.ts
```

## 6. Current Migration State

The project has already removed the old Claude-specific and old launcher code:

- `src/loop.ts`
- `src/providers/telegramLauncher.ts`
- `src/session/Session.ts`
- `src/providers/claude/`
- `src/claude/`
- top-level `src/telegram/`
- `src/providers/codebuddy/eventAdapter.ts`

The remaining cleanup is architectural convergence, not another redesign.

## 7. Known Inconsistencies To Clean Up

1. **Dual session cores**: `SemanticSessionRuntime` is the active core, while `QueryLoop` still exposes runtime-like APIs. Shrink `QueryLoop` into metadata.
2. **Unused pipeline wiring**: `messageRouter` still creates a `MiddlewarePipeline`, and `TopicSessionConfig` accepts it, but `SemanticSessionRuntime` does not use it. Remove this from the active path or explicitly mark it test-only.
3. **Telegram package split**: `channel/telegram` and `transport/telegram` both contain active Telegram code. Merge handlers, renderer, keyboards, and port into one package boundary.
4. **Legacy actor**: `runtime/sessionActor.ts` is only test-referenced. Either delete it or make it part of the runtime intentionally.
5. **MCP entry duplication**: `mcp/stdio.ts` and `mcp/server.ts` register overlapping tools through different paths. Decide which is the public runtime entry and keep the other as a test helper if needed.
6. **Config compatibility fields**: `claudeSessionId`, group-level `conversationId`, and group-level `queryInProgress` are legacy persistence fields. Keep migration reads, but avoid using them as new state.
7. **Tests reflect multiple eras**: architecture tests still validate older `QueryLoop/Pipeline` assumptions. Rewrite them around semantic runtime invariants.

## 8. Target Simplification

The intended simple shape is:

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

Target ownership:

- `SessionManager` owns lookup and persistence.
- `TopicSession` owns wiring.
- `SemanticSessionRuntime` owns lifecycle and commands.
- `ProviderSemanticAdapter` owns provider normalization.
- `ChannelProjector` owns visible message projection.
- `DeliveryOutbox` owns delivery reliability.
- `TelegramPort` owns Telegram API details.

Anything outside this chain should either be a utility, a test helper, or deleted.

## 9. Stability Invariants

- One Telegram topic maps to one active `TopicSession`.
- One `TopicSession` owns one session-scoped provider instance.
- Runtime input is serialized through `SemanticSessionRuntime.dispatch()`.
- Provider events are normalized before rendering.
- Tool updates are merged by stable tool call id before editing channel messages.
- Channel sends/edits go through `DeliveryOutbox`.
- Provider switch creates or installs a new provider context and clears incompatible provider session identity.
- Scheduled and MCP-injected messages use the same runtime path as user messages.
- Telegram-specific behavior does not leak into provider adapters.
- Persistence keeps backwards-compatible migration reads, but new state should be topic-level.

## 10. Recommended Cleanup Order

1. Update tests to assert the semantic runtime path.
2. Remove unused `MiddlewarePipeline` construction from `messageRouter` and `TopicSessionConfig`.
3. Rename or shrink `QueryLoop` into session metadata.
4. Merge `transport/telegram` into `channel/telegram`.
5. Decide whether `runtime/sessionActor.ts` is deleted or used.
6. Consolidate MCP server entry registration.
7. Remove or isolate legacy config APIs once migration safety is no longer needed.

