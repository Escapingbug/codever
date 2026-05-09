# Codever Architecture Design

## 1. Problem Definition

### Core Purpose

Codever is an **ACP ↔ Channel Bridge**. It connects ACP-compatible coding agents to messaging channels (currently Telegram), faithfully replicating the local TUI experience remotely. On top of this bridge, codever exposes itself to agents as an MCP server, enabling proactive messaging, self-awareness, and management capabilities that don't exist in local TUI.

### What Codever Is Not

- Not a multi-agent orchestrator (SupervisorNode concept abandoned)
- Not a Claude-specific tool (ClaudeProvider removed, all agents go through ACP)
- Not a generic chatbot framework (focused on coding agent interaction)

### Critical vs. Non-Critical Requirements

| Priority | Requirement | Impact if broken |
|----------|-------------|-----------------|
| **Critical** | Messages reach the agent; agent output reaches the user | Project is completely unusable |
| **Critical** | Agent subprocess lifecycle is controllable (start, run, cancel, destroy) | Subprocess leaks or becomes unresponsive |
| **Critical** | Each channel session has independent state | One session's bug affects others |
| **Critical** | Markdown rendering preserves structure (tables, code blocks, lists) | Agent output appears garbled |
| **High** | Permission approval works (tool calls require user confirmation) | Approval failure blocks queries |
| **High** | ACP tool calls displayed correctly (tool_use → updates → tool_result) | User can't track what the agent is doing |
| **Medium** | MCP tools work (proactive messaging, self-management) | Extended features unavailable |
| **Low** | Formatted output polish (tool icons, diff summaries) | Visual degradation |

---

## 2. Architecture Overview

### Design Principles

1. **Bridge, not orchestrator** — Codever connects ACP to channels. It doesn't orchestrate agents.
2. **Channel-agnostic core** — CoreSession, Pipeline, Scheduler know nothing about Telegram.
3. **Structure-aware rendering** — Markdown is never split mid-structure (table, code block, list).
4. **MCP as extension** — Agent-to-codever communication goes through MCP tools, not special protocols.
5. **Single session model** — No Node/Router abstractions. CoreSession talks directly to AgentProvider.

### Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Channel Layer (replaceable: Telegram / Discord / CLI)          │
│  TelegramPort implements ChannelPort:                           │
│    send(), edit(), requestDecision(), notifyStatus()            │
│  + Channel-specific handlers (commands, callbacks, routing)     │
├─────────────────────────────────────────────────────────────────┤
│  Bridge Layer (wires Core + Provider + Channel)                 │
│  SessionBridge: CoreSession + Provider + ChannelPort + Pipeline │
│  SessionManager: lifecycle, persistence, provider switching     │
├─────────────────────────────────────────────────────────────────┤
│  Core Layer (channel-agnostic, provider-agnostic)               │
│  CoreSession: state machine + message queue + permissions       │
│  EventBus: decouples session from rendering                     │
│  Scheduler: timed task execution → receiveInput()               │
├─────────────────────────────────────────────────────────────────┤
│  Middleware Layer (output processing pipeline)                   │
│  Pipeline: structure-aware text buffering + flush               │
│  FormattingMiddleware: AgentEvent → Markdown/HTML               │
│  TimeoutMiddleware: heartbeat + timeout detection               │
│  (dedup, content-limit: inlined into pipeline)                  │
├─────────────────────────────────────────────────────────────────┤
│  MCP Layer (agent → codever capabilities)                       │
│  MCP Server: exposed to agent via ACP mcpServers                │
│  Tools: schedule_reminder, list_sessions, set_topic_name, ...   │
├─────────────────────────────────────────────────────────────────┤
│  Provider Layer (ACP protocol)                                  │
│  AcpProvider base → OpencodeProvider / CodebuddyProvider        │
│  Handles: newSession, loadSession, prompt, cancel, reinit       │
└─────────────────────────────────────────────────────────────────┘
```

### Dependency Rule

Dependencies only point downward:

```
Channel → Bridge (interfaces only)
Bridge  → Core + Provider + Middleware + ChannelPort interface
Core    → nothing
MCP     → Core + Bridge (management APIs)
Middleware → Core (types)
Provider → nothing external
```

---

## 3. Core Abstractions

### 3.1 CoreSession — State Machine

The session state machine is the sole authority for query lifecycle.

```
                    ┌──────────┐
                    │   idle   │ ← Waiting for input
                    └────┬─────┘
                         │ Input arrives (user message / scheduler trigger / MCP)
                         ▼
                    ┌──────────┐
              ┌─────│ querying │ ← Executing a query
              │     └────┬─────┘
              │          │ Query completes/fails
              │          ▼
              │     ┌──────────┐
              │     │   idle   │
              │     └──────────┘
              │
              │  Interrupt (/stop, /new)
              │          │
              │          ▼
              │     ┌───────────┐
              └────►│ canceling │
                    └────┬──────┘
                         │ Cancel completes
                         ▼
                    ┌──────────┐
                    │   idle   │
                    └──────────┘

  Any state ──(destroy)──► ┌──────────┐
                             │   dead   │
                             └──────────┘
```

```typescript
// src/core/session.ts

type SessionState = 'idle' | 'querying' | 'canceling' | 'dead'

interface SessionInput {
    text: string
    source: 'user' | 'scheduler' | 'system'  // Agent can感知消息来源
    username?: string
    chatId?: number
    messageThreadId?: number
}

class CoreSession {
    // Identity
    readonly id: string
    channelId: string                    // 通用 channel 标识（替代 groupChatId）
    messageThreadId: number | null       // Channel 内的子标识

    // Provider
    providerName: string
    providerSessionId: string | null     // ACP session ID，用于 resume

    // Config (pending pattern: apply on idle, queue on querying)
    model: string | null
    verboseLevel: 0 | 1 | 2
    timeoutSeconds: number
    providerSettings: Record<string, unknown>

    // Lifecycle
    processInput(input: SessionInput): Promise<void>
    interrupt(reason: 'stop' | 'new' | 'replace'): Promise<void>
    destroy(): void

    // Permission bridge
    resolvePermission(requestId: string, decision: PermissionDecision): boolean
}
```

**Key constraints:**
- State transitions are atomic.
- In `querying`/`canceling` state, new messages queue.
- `cancel()` never kills the subprocess — only `destroy()` does.
- `canceling` state auto-rejects all pending permission requests.
- `providerSessionId` is cleared on unrecoverable errors and on `/new`.

### 3.2 EventBus

```typescript
// src/core/types.ts

type SessionEvent =
    | { type: 'session.created'; sessionId: string }
    | { type: 'session.destroyed'; sessionId: string }
    | { type: 'session.state_changed'; sessionId: string; from: SessionState; to: SessionState }
    | { type: 'query.started'; sessionId: string; queryId: string }
    | { type: 'query.event'; sessionId: string; queryId: string; event: AgentEvent }
    | { type: 'query.completed'; sessionId: string; queryId: string; result: { status: string } }
    | { type: 'query.error'; sessionId: string; queryId: string; error: unknown }
    | { type: 'query.timeout'; sessionId: string; queryId: string; elapsed: number }
    | { type: 'timeout.continue'; sessionId: string }
    | { type: 'permission.request'; sessionId: string; requestId: string; toolName: string; input: unknown }
    | { type: 'permission.respond'; sessionId: string; requestId: string; decision: PermissionDecision }
    | { type: 'message.incoming'; sessionId: string; text: string }
    | { type: 'message.outgoing'; sessionId: string; text: string }
    | { type: 'message.queued'; sessionId: string; queueSize: number }
```

### 3.3 Scheduler

Handles timed task execution (for proactive messaging via MCP `schedule_reminder`).

```typescript
// src/core/scheduler.ts

interface ScheduledTask {
    id: string
    sessionId: string          // Target session
    triggerAt: number          // Unix timestamp
    message: string            // Prompt sent to agent
    context?: string           // Why the agent is being invoked
}

class Scheduler {
    // Schedule a one-shot task, persisted to config
    schedule(task: Omit<ScheduledTask, 'id'>): ScheduledTask

    // Cancel a task
    cancel(taskId: string): void

    // Load persisted tasks on startup
    loadPersisted(): void

    // On trigger: CoreSession.processInput({ text: task.message, source: 'scheduler' })
    // After execution: task is automatically deleted
}
```

**Design decisions:**
- One-shot only (no recurring). Agent can re-register via MCP tool.
- Persisted to config — survives codever restart.
- Triggers via `processInput()` — same path as user messages, no special state needed.

---

## 4. ChannelPort — Channel Abstraction

The interface between bridge logic and any messaging channel.

```typescript
// src/bridge/channelPort.ts

interface ChannelMessage {
    text: string
    format: 'markdown' | 'html' | 'plain'
    replyMarkup?: ReplyMarkup
}

interface DecisionOption {
    label: string
    value: string
}

interface DecisionRequest {
    type: 'permission' | 'question'
    title: string
    details?: string
    options: DecisionOption[]
}

interface DecisionResponse {
    value: string
}

interface SessionStatus {
    state: SessionState
    model?: string
    cwd: string
    provider: string
}

interface ChannelPort {
    /** Send a message to the channel */
    send(message: ChannelMessage): Promise<void>

    /** Edit an existing message (for progressive tool call display) */
    edit?(messageId: string | number, message: ChannelMessage): Promise<void>

    /** Request a user decision (permission, question) */
    requestDecision(request: DecisionRequest): Promise<DecisionResponse>

    /** Notify channel of session status change */
    notifyStatus(status: SessionStatus): void

    /** Send typing/uploading indicator */
    sendChatAction?(action: string): void
}
```

**Why not just "send"?** Permission flow is fundamentally interactive — the channel must display options and wait for user response. `requestDecision()` abstracts this: Telegram implements it as inline keyboard, Discord as buttons, CLI as text prompts.

**Why `edit()`?** ACP tool calls arrive incrementally (tool_call → tool_call_updates → tool_result). Instead of sending duplicate messages, channels that support editing can update the original tool call message in place.

---

## 5. Bridge Layer

### 5.1 SessionBridge

Replaces the current `coreSessionLauncher.ts`. Wires CoreSession + Provider + ChannelPort + Pipeline.

```typescript
// src/bridge/sessionBridge.ts

interface BridgeSession {
    receiveInput(input: SessionInput): void
    destroy(): void
    readonly state: SessionState
    readonly coreSession: CoreSession
}

function createBridgeSession(options: {
    coreSession: CoreSession
    provider: AgentProvider
    channelPort: ChannelPort
    pipeline: MiddlewarePipeline
    scheduler: Scheduler
}): BridgeSession
```

**Wiring inside createBridgeSession:**

```
CoreSession EventBus
  │
  ├── 'query.started' ──→ Pipeline.onQueryStarted()
  │                       ChannelPort.notifyStatus({ state: 'querying' })
  │                       ChannelPort.send("🚀 Session started")
  │
  ├── 'query.event' ───→ Pipeline.processEvent(event)
  │                       Pipeline output → ChannelPort.send()
  │                       (markdown → format:'markdown', html → format:'html')
  │
  ├── 'query.completed' → Pipeline.onQueryCompleted()
  │                       ChannelPort.notifyStatus({ state: 'idle' })
  │
  ├── 'query.error' ───→ ChannelPort.send("❌ Error: ...")
  │                       ChannelPort.notifyStatus({ state: 'idle' })
  │
  ├── 'query.timeout' ──→ ChannelPort.send(timeoutMsg, { replyMarkup: timeoutKeyboard })
  │
  ├── 'permission.request' → ChannelPort.requestDecision(...)
  │                            Result → CoreSession.resolvePermission()
  │
  └── 'session.state_changed' → ChannelPort.notifyStatus(...)
                                 Pipeline.stopTimeout() on idle/dead
```

### 5.2 SessionManager

Centralized session lifecycle management. Absorbs the current `coreSessionRunners` map and config persistence.

```typescript
// src/bridge/sessionManager.ts

class SessionManager {
    // Runtime sessions
    private sessions = new Map<string, BridgeSession>()  // sessionId → session

    // Channel → session mapping
    private channelSessions = new Map<string, string>()  // channelId → sessionId

    // Group-level state (cwd, settings, archived — keyed by channel group ID)
    private groupCwds = new Map<string, string>()
    private groupSettings = new Map<string, GroupSettings>()
    private archivedGroups = new Set<string>()

    // Lifecycle
    createSession(channelId: string, options: SessionOptions): BridgeSession
    getSession(sessionId: string): BridgeSession | undefined
    getSessionByChannel(channelId: string): BridgeSession | undefined
    destroySession(sessionId: string): void

    // Operations
    switchProvider(channelId: string, providerName: string): BridgeSession  // destroy + recreate
    resetSession(channelId: string): void                                    // /new
    archiveGroup(channelId: string): void
    unarchiveGroup(channelId: string): void
    listSessions(): BridgeSession[]

    // Persistence (delegated to config)
    saveGroupState(groupId: string, state: Partial<GroupState>): void
    loadPersistedState(): void
}
```

**Why SessionManager owns the runner map:** Currently `coreSessionRunners` is passed through bot.ts → handler context, which is fragile. SessionManager is the single source of truth for session lifecycle.

**Provider switch = session recreation:** Unlike the current buggy approach (changing providerName but keeping old provider reference), switching provider destroys the old session and creates a new one with the new provider. This is correct because the new provider has a completely different ACP connection.

---

## 6. Middleware Pipeline

### 6.1 Structure-Aware Text Buffering

The pipeline's text buffer is **structure-aware** — it never flushes mid-structure (table, code block, list, blockquote).

```typescript
// src/middleware/pipeline.ts

class MiddlewarePipeline {
    private textBuffer = ''

    processEvent(event: AgentEvent, context: MiddlewareContext): PipelineOutput {
        // FormattingMiddleware converts event → formatted string
        // TimeoutMiddleware tracks heartbeat/state
        // Then route to handleTextEvent or handleNonTextEvent
    }

    private handleTextEvent(formatted: string): PipelineOutput {
        this.textBuffer += formatted

        if (this.shouldFlush()) {
            return this.flushAsMessage()
        }
        return { messages: [], event }
    }

    private shouldFlush(): boolean {
        // 1. Hard limit (3800 chars) — flush at last structure boundary
        if (this.textBuffer.length >= 3800) return true

        // 2. Soft limit (500 chars) — flush after timeout IF no unclosed structure
        if (this.textBuffer.length >= 500 && !this.hasUnclosedStructure()) {
            this.scheduleFlush(TEXT_BUFFER_FLUSH_MS)
        }

        // 3. Structure just completed — flush immediately
        if (this.structureJustCompleted()) return true

        return false
    }
}
```

### 6.2 Structure Boundary Detection

```typescript
// src/middleware/structureDetector.ts

interface StructureState {
    inCodeBlock: boolean
    inTable: boolean
    inList: boolean       // ordered or unordered
    inBlockquote: boolean
}

class StructureDetector {
    /** Check if buffer has any unclosed markdown structure */
    hasUnclosedStructure(buffer: string): boolean {
        return this.detect(buffer).hasUnclosed
    }

    /** Check if the last addition to buffer completed a structure */
    justCompletedStructure(prevBuffer: string, currentBuffer: string): boolean {
        // e.g., code block just closed, table ended (non-| line after | lines),
        // list ended (blank line after list items), blockquote ended
    }

    /** Find the best split point within maxLen that respects structure boundaries */
    findStructureBoundary(buffer: string, maxLen: number): number {
        // Priority of split points (high to low):
        // 1. Blank line (paragraph/table/list boundary) — \n\n
        // 2. Table end (|...|\n followed by non-| line or blank line)
        // 3. Heading line (# ...)
        // 4. Line break (\n)
        // 5. Hard cut at maxLen (last resort)
    }
}
```

### 6.3 Tool Call Progressive Display

ACP tool calls arrive incrementally. The pipeline buffers and displays them correctly:

```
Event sequence from ACP:
  1. tool_call (pending, input may be incomplete)
  2. tool_call_update (running, input complete, locations added)
  3. tool_call_update (completed/failed, output available)

Pipeline behavior:
  1. First tool_use → format → send to channel (e.g., "💻 $ npm run build")
     If input is incomplete → buffer briefly (500ms) waiting for completion
  2. Subsequent tool_use updates → merge into ConversationModel state
     If formatted output changed AND channel supports edit → edit existing message
     If formatted output unchanged → skip (dedup)
  3. tool_result → send result (subject to verbose level filtering)
```

### 6.4 Middleware Composition

After cleanup, only two real middleware remain in the chain:

| Middleware | Role | Why it's a middleware |
|-----------|------|----------------------|
| **FormattingMiddleware** | AgentEvent → Markdown/HTML string | Transforms events in the chain |
| **TimeoutMiddleware** | Heartbeat tracking, state updates | Has lifecycle (start/stop), mutates state on events |

Inlined into pipeline (not middleware):
- **Dedup** — `Set<string>` of content hashes, checked by pipeline before sending
- **Content limit** — `splitHtmlChunks()` utility, called by pipeline when needed

Deleted:
- **PermissionMiddleware** — redundant with `TelegramPermissionHandler`'s auto-approval logic; never wired in active path

---

## 7. Channel Implementation: Telegram

### 7.1 TelegramPort

```typescript
// src/channel/telegram/telegramPort.ts

class TelegramPort implements ChannelPort {
    constructor(
        private renderer: TelegramRenderer,
        private permissionHandler: TelegramPermissionHandler,
        private chatId: number,
        private messageThreadId?: number,
    ) {}

    async send(message: ChannelMessage): Promise<void> {
        switch (message.format) {
            case 'markdown':
                await this.renderer.sendMarkdown(message.text, { replyMarkup: message.replyMarkup })
                break
            case 'html':
                await this.renderer.sendFormatted(message.text, { replyMarkup: message.replyMarkup })
                break
            case 'plain':
                await this.renderer.sendPlain(message.text)
                break
        }
    }

    async edit(messageId: number, message: ChannelMessage): Promise<void> {
        // Use bot.api.editMessageText() to update existing message
        // Supports progressive tool call display
    }

    async requestDecision(request: DecisionRequest): Promise<DecisionResponse> {
        if (request.type === 'permission') {
            return this.permissionHandler.requestDecision(request)
        }
        // AskUserQuestion etc.
    }

    notifyStatus(status: SessionStatus): void {
        // Optional: send status change notification
    }

    sendChatAction(action: string): void {
        this.renderer.sendChatAction(action as any)
    }
}
```

### 7.2 Permission Handler

`TelegramPermissionHandler` implements `requestDecision()` by sending inline keyboards to Telegram and waiting for callback responses. It no longer directly calls `bot.api.sendMessage` — it goes through `TelegramPort.send()` for consistent message routing.

### 7.3 Command Handlers

Telegram-specific commands (`/cwd`, `/stop`, `/new`, `/archive`, `/model`, `/provider`, `/resume`, etc.) are implemented as handlers in `src/channel/telegram/handlers/`. They operate on `SessionManager` and `BridgeSession` APIs — no direct provider or renderer access.

| Command | Implementation | SessionManager API |
|---------|---------------|-------------------|
| `/new` | Reset session context | `sessionManager.resetSession(channelId)` |
| `/archive` | Destroy session, block auto-creation | `sessionManager.archiveGroup(channelId)` |
| `/stop` | Interrupt current query | `session.interrupt('stop')` |
| `/model X` | Set model (pending config) | `session.coreSession.setModel(X)` |
| `/provider X` | Switch provider | `sessionManager.switchProvider(channelId, X)` |
| `/resume ID` | Resume ACP session | `session.coreSession.setProviderSessionId(ID)` |
| `/cwd PATH` | Set working directory | `sessionManager.setGroupCwd(groupId, PATH)` |
| `/session` | List provider sessions | `provider.listSessions(cwd)` |

---

## 8. MCP Server

### 8.1 Architecture

Codever hosts an MCP server (stdio transport) and passes it to ACP sessions via the `mcpServers` parameter. The agent discovers codever's tools automatically.

```
Agent subprocess (opencode/codebuddy)
  │
  ├── Built-in tools (Bash, Read, Edit, Write, ...)
  │
  └── MCP tools from codever:
      ├── schedule_reminder    → proactive messaging
      ├── send_message         → immediate notification
      ├── list_sessions        → self-awareness
      ├── switch_session       → session management / delegation
      ├── set_topic_name       → channel management
      ├── change_model         → configuration
      └── get_codever_status   → self-awareness
```

### 8.2 Integration Point

```typescript
// In AcpProvider.startQuery():

const mcpServers = [{
    name: 'codever',
    transport: { type: 'stdio', command: 'node', args: [mcpServerScript] }
    // Or: { type: 'sse', url: 'http://localhost:PORT/sse' }
}]

clientManager.newSession({ cwd, mcpServers })
```

### 8.3 Tool Implementations

```typescript
// src/mcp/tools/notify.ts
function scheduleReminder(args: { delayMs: number; message: string; context?: string },
                          ctx: { session: CoreSession; scheduler: Scheduler }) {
    ctx.scheduler.schedule({
        sessionId: ctx.session.id,
        triggerAt: Date.now() + args.delayMs,
        message: args.message,
        context: args.context,
    })
}

// src/mcp/tools/session.ts
function listSessions(args: {}, ctx: { sessionManager: SessionManager; provider: AgentProvider; cwd: string }) {
    return ctx.provider.listSessions(ctx.cwd)
}

function switchSession(args: { sessionId: string }, ctx: { session: CoreSession }) {
    ctx.session.setProviderSessionId(args.sessionId)
    // Next message will use loadSession with the specified ID
}

// src/mcp/tools/config.ts
function setTopicName(args: { name: string }, ctx: { channelPort: ChannelPort; chatId: number }) {
    // Call Telegram API to rename forum topic
}
```

### 8.4 Proactive Message Flow

```
1. Agent calls schedule_reminder({ delayMs: 3600000, message: "Check test results" })
   → Scheduler persists task
   → Tool returns: "Reminder scheduled for 13:00"

2. One hour later, Scheduler fires
   → CoreSession.processInput({ text: "[Reminder] Check test results", source: 'scheduler' })
   → Same query flow as user message
   → Agent generates response
   → TelegramPort sends response to channel
   → User sees the agent's proactive message in Telegram
```

### 8.5 Session Management / Delegation Flow

```
1. Agent A is running in session-1
2. Agent A calls switch_session({ sessionId: "session-2-id" })
   → Current session's providerSessionId is saved
   → Session switches to session-2
3. Agent A sends a message that goes to session-2's agent (Agent B)
   → This enables "delegation" without codever implementing complex orchestration
4. Agent A calls switch_session({ sessionId: "session-1-id" }) to return
```

This is simpler than a SupervisorNode because:
- No proxy agent needed
- No event filtering
- The agent manages its own context switching
- Codever just provides the tools

---

## 9. Directory Structure

```
src/
  core/                              # Channel-agnostic, provider-agnostic
    session.ts                       # CoreSession state machine
    eventBus.ts                      # DefaultEventBus
    types.ts                         # SessionEvent, SessionState, etc.
    scheduler.ts                     # Timed task execution

  bridge/                            # Wires core + provider + channel
    sessionBridge.ts                 # createBridgeSession() — EventBus wiring
    channelPort.ts                   # ChannelPort interface + types
    sessionManager.ts                # Session lifecycle + persistence + runner map

  channel/                           # Channel implementations
    telegram/
      telegramPort.ts                # ChannelPort implementation
      renderer.ts                    # Telegram message sending (tgmdrender + HTML)
      permissionUI.ts                # Permission inline keyboard handler
      keyboard.ts                    # Keyboard builders
      agentFormatter.ts              # AgentEvent → HTML/Markdown formatting
      ConversationModel.ts           # Tool call state tracking
      pairing.ts                     # User pairing flow
      handlers/
        dm.ts                        # DM commands
        groupCommands.ts             # Group commands
        settings.ts                  # Settings commands
        callbacks.ts                 # Callback query handlers
        messageRouter.ts             # Message routing + session creation
      bot.ts                         # Bot factory + handler registration

  mcp/                               # MCP server (codever → agent tools)
    server.ts                        # MCP server entry point
    tools/
      notify.ts                      # schedule_reminder, send_message
      session.ts                     # list_sessions, switch_session
      config.ts                      # change_model, set_topic_name
      self.ts                        # get_codever_status

  middleware/                         # Output processing
    pipeline.ts                      # Structure-aware text buffering + flush
    structureDetector.ts             # Markdown structure boundary detection
    formatting.ts                    # AgentEvent → Markdown/HTML
    timeout.ts                       # Heartbeat + timeout detection
    types.ts                         # Middleware interface

  providers/                          # ACP protocol layer (unchanged)
    provider.ts                      # AgentProvider interface
    types.ts                         # AgentEvent types
    registry.ts                      # Provider registry
    acp/
      index.ts                       # AcpProvider base class
      AcpClientManager.ts            # ACP client
      eventAdapter.ts                # ACP → AgentEvent mapping
    opencode/
      index.ts                       # OpencodeProvider
    codebuddy/
      index.ts                       # CodebuddyProvider

  utils/
    formatting.ts                    # escapeHtml, sanitizeXmlLikeTags, splitHtmlChunks
    nodePath.ts                      # resolveNodePath (from claude/sdk/utils)
    hookSettings.ts                  # generateHookSettingsFile (from claude/utils)
    hookServer.ts                    # startHookServer (from claude/utils)
    tgmdrender.ts                    # Python tgmdrender wrapper
    PushableAsyncIterable.ts
    unwrapToolOutput.ts
    groupLogger.ts
    lock.ts

  config.ts                          # Persistent configuration
  daemon.ts                          # Composition root
```

---

## 10. Data Flow

### 10.1 User Message → Agent Response

```
Telegram message
  → channel/telegram/handlers/messageRouter.ts
    → SessionManager.getSessionByChannel(channelId)
    → if no session: createSession() → createBridgeSession()
    → BridgeSession.receiveInput({ text, source: 'user' })
      → CoreSession.processInput()
        → state idle→querying
        → provider.startQuery(text, config)
        → for-await AgentEvent stream
          → EventBus.emit('query.event')
            → sessionBridge listener
              → Pipeline.processEvent()
                → FormattingMiddleware → formatted string
                → StructureDetector → flush decision
                → Pipeline output: ChannelMessage[]
              → ChannelPort.send() for each message
                → TelegramPort.send() → renderer → Telegram API
        → state querying→idle
        → Process queued messages
```

### 10.2 Permission Flow

```
Agent calls a tool (e.g., Bash)
  → ACP protocol: requestPermission()
  → AcpProvider → TelegramPermissionHandler.handleToolCall()
    → If auto-approved (mode/already-approved) → return allow
    → Otherwise:
      → ChannelPort.requestDecision({ type: 'permission', ... })
        → TelegramPort: send inline keyboard to Telegram
        → User taps button
        → Callback handler → DecisionResponse
      → Return allow/deny to provider
  → ACP agent receives permission result, executes or skips tool
```

### 10.3 ACP Tool Call Display Flow

```
ACP session/update: tool_call (name=Bash, input="npm test", status=pending)
  → eventAdapter → AgentEvent { kind: 'tool_use', toolName: 'Bash', input: 'npm test' }
  → EventBus 'query.event'
  → Pipeline:
    → FormattingMiddleware: ConversationModel.applyEvent() → renderToolUse() → "💻 $ npm test"
    → Pipeline: non-text event → flush text buffer first → send tool message
    → ChannelPort.send({ text: "💻 $ npm test", format: 'html' })

ACP session/update: tool_call_update (status=running, isInputComplete=true, locations=[...])
  → eventAdapter → AgentEvent { kind: 'tool_use', toolName: 'Bash', ... }  (update)
  → Pipeline:
    → FormattingMiddleware: ConversationModel.applyEvent() → merge into existing state
    → renderToolUse() → may produce same or different formatted output
    → Dedup check: if same as before → skip
    → If different AND ChannelPort.edit exists → edit previous message
    → If no edit support → skip (don't duplicate)

ACP session/update: tool_call_update (status=completed, output="...")
  → eventAdapter → AgentEvent { kind: 'tool_result', toolName: 'Bash', output: '...' }
  → Pipeline:
    → FormattingMiddleware: renderToolResult() → "✅ Done | 2.3s" (at verbose=1)
    → Send result message
```

### 10.4 Scheduler → Proactive Message

```
Agent calls schedule_reminder({ delayMs: 60000, message: "Tests done?" })
  → MCP tool handler → Scheduler.schedule(task)
  → Tool returns "Reminder scheduled"
  → (1 minute later)
  → Scheduler checks tasks → task is due
  → CoreSession.processInput({ text: "[Reminder] Tests done?", source: 'scheduler' })
  → Same flow as user message → agent responds → channel displays response
  → Scheduler removes completed task
```

---

## 11. Session Management Details

### 11.1 Session Resume

```
/resume <sessionId>
  → handler: session.coreSession.setProviderSessionId(sessionId)
  → persisted: config.saveGroupState({ providerSessionId })
  → next message: CoreSession.startQuery()
    → config.sessionId is set → AcpProvider.startQuery() uses loadSession()
    → loadSession replays history → drainSessionUpdates() discards replayed events
    → prompt() sends new user message in the resumed session context
```

### 11.2 Provider Switch

```
/provider opencode
  → SessionManager.switchProvider(channelId, 'opencode')
    → Destroy old session (interrupt if active, clear runner)
    → Create new session with opencode provider
    → Old providerSessionId is gone (belongs to old provider)
    → New session starts fresh with newSession()
```

### 11.3 Model Switch (Pending Config)

```
/model sonnet
  → session.coreSession.setModel('sonnet')
  → If idle: stored immediately, used on next query
  → If querying: queued in pendingConfig, applied when next query starts
  → At query start: AcpProvider calls setSessionModel() on the ACP client
```

### 11.4 Stale Session Recovery

```
Codever killed mid-query → queryInProgress flag persisted
  → On restart, new message arrives
  → messageRouter checks queryInProgress
  → If true: clear providerSessionId, start fresh session
  → If false: resume with saved providerSessionId
```

---

## 12. Markdown Rendering Strategy

### 12.1 The Contract

**Pipeline promises:** Each flush produces structurally complete Markdown.
**Channel promises:** Received Markdown is structurally complete and can be rendered correctly.

### 12.2 Structure-Aware Flush Rules

| Condition | Action |
|-----------|--------|
| Buffer has unclosed code block (```) | Wait (force-flush after 10s) |
| Buffer has unclosed table (`|...|` lines without blank line after) | Wait |
| Buffer has unclosed list (list items without blank line after) | Wait |
| Buffer ≥ 3800 chars | Split at last structure boundary before 3800 |
| Buffer ≥ 500 chars, no unclosed structure | Flush after 600ms |
| Structure just completed (code block closed, table ended, list ended) | Flush immediately |
| Query completed | Force flush everything |

### 12.3 tgmdrender Pipeline

```
Complete Markdown string (from pipeline flush)
  → tgmdrender.tgmdSplit()
    → _split_by_tables(): separates tables from text
    → Text segments: telegramify_markdown.convert() → text + entities
    → split_entities(): splits by UTF-16 length limit, preserving entities
    → Table segments: kept as markdown
  → For each segment:
    → table → tgmdTableImage() → send as photo
    → text + entities → sendEntityMessage() → Telegram API
```

This pipeline works correctly because:
1. Pipeline guarantees structurally complete input (no half-tables)
2. tgmdrender extracts tables before conversion (no table-in-text splitting)
3. Tables rendered as images (no Telegram MarkdownV2 table limitations)
4. Entity-based rendering preserves formatting (bold, italic, code, links)

---

## 13. Migration Plan

### Phase 1: Pure Deletion (Zero Risk)

Delete ~2,100 lines of dead code:

| File | Lines | Reason |
|------|-------|--------|
| `src/loop.ts` | 18 | Zero callers |
| `src/providers/telegramLauncher.ts` | 691 | Only caller was loop.ts |
| `src/session/Session.ts` | 99 | Old Session class, never instantiated |
| `src/claude/utils/permissionHandler.ts` | 299 | Duplicate of permissionUI.ts |
| `src/providers/claude/` | ~200 | Deprecated, doesn't use ACP |
| `src/claude/sdk/` (query/stream/types) | ~520 | Only used by ClaudeProvider |
| `src/claude/claudeSessions.ts` | ~50 | Only used by ClaudeProvider |
| `src/providers/codebuddy/eventAdapter.ts` | ~106 | Dead old-SDK adapter |
| `src/telegram/keyboard.ts` | 208 | Duplicate of transport/telegram/keyboard.ts |
| `src/telegram/formatter.ts` | 76 | Zero callers |

Move shared utils out of `src/claude/`:
- `claude/sdk/utils.ts` → `utils/nodePath.ts`
- `claude/utils/generateHookSettings.ts` → `utils/hookSettings.ts`
- `claude/utils/startHookServer.ts` → `utils/hookServer.ts`

### Phase 2: SessionManager Cleanup (Low Risk)

- Remove old Session maps and methods from SessionManager
- Fix `/status` bug: `listActive()` → `listActiveCoreSessions()`
- Fix `getCwdForChat()`: `getByGroupChatId()` → `getCoreSessionByGroup()`
- Fix `daemon.ts` hook server: use core session lookup
- Remove ClaudeProvider registration from `daemon.ts`

### Phase 3: Middleware Simplification (Medium Risk)

- Delete `permission.ts` middleware (redundant with TelegramPermissionHandler)
- Inline dedup into pipeline (Set<string>, two methods)
- Move `splitHtmlChunks` to `utils/formatting.ts`, inline content-limit into pipeline
- Add `structureDetector.ts` for markdown-aware flush
- Implement tool call progressive display (brief buffer + edit support)

### Phase 4: Bridge Refactoring (Medium Risk)

- Extract `ChannelPort` interface from current Telegram code
- Create `sessionBridge.ts` replacing `coreSessionLauncher.ts`
- Create `TelegramPort` implementing `ChannelPort`
- Move `coreSessionRunners` map into `SessionManager`
- Fix provider switch (destroy + recreate)
- Replace `groupChatId` with `channelId` in CoreSession
- Merge `src/telegram/` into `src/channel/telegram/`

### Phase 5: MCP Server + Scheduler (New Feature)

- Implement MCP server with stdio transport
- Implement tools: `schedule_reminder`, `list_sessions`, `switch_session`, etc.
- Implement `Scheduler` with config persistence
- Wire `mcpServers` parameter in `AcpProvider.startQuery()`

### Phase 6: Final Cleanup

- Remove `src/claude/` directory entirely
- Remove `src/telegram/` directory
- Remove `src/node/` directory (never existed)
- Update `AGENTS.md` with new architecture
- Verify all tests pass

---

## 14. Code Size Estimates

### Core Layer (~200 LOC)

```
src/core/
  session.ts           ~400 LOC  State machine + message queue + permissions (existing, stable)
  eventBus.ts           ~60 LOC  EventBus interface + implementation (existing)
  types.ts              ~30 LOC  SessionEvent types (existing)
  scheduler.ts         ~120 LOC  NEW: Timed task scheduling + persistence
```

### Bridge Layer (~300 LOC)

```
src/bridge/
  sessionBridge.ts     ~250 LOC  CoreSession + Provider + ChannelPort + Pipeline wiring
  channelPort.ts        ~60 LOC  ChannelPort interface + types
  sessionManager.ts    ~200 LOC  Session lifecycle + persistence (refactored from current)
```

### Channel Layer (~800 LOC)

```
src/channel/telegram/
  telegramPort.ts       ~80 LOC  ChannelPort implementation
  renderer.ts          ~270 LOC  Message sending (existing, stable)
  permissionUI.ts      ~340 LOC  Permission handler (existing)
  keyboard.ts          ~210 LOC  Keyboard builders (existing)
  agentFormatter.ts    ~490 LOC  AgentEvent → HTML formatting (existing)
  ConversationModel.ts ~160 LOC  Tool state tracking (existing)
  pairing.ts           ~100 LOC  User pairing (existing)
  handlers/           ~1000 LOC  Command/callback handlers (existing, minor changes)
  bot.ts                ~45 LOC  Bot factory (existing)
```

### MCP Layer (~200 LOC)

```
src/mcp/
  server.ts             ~80 LOC  MCP server entry point
  tools/               ~120 LOC  Tool implementations (4-5 tools)
```

### Middleware Layer (~400 LOC)

```
src/middleware/
  pipeline.ts          ~300 LOC  Structure-aware buffering + flush + dedup + content-limit
  structureDetector.ts  ~80 LOC  NEW: Markdown structure detection
  formatting.ts         ~53 LOC  FormattingMiddleware (existing)
  timeout.ts           ~142 LOC  TimeoutMiddleware (existing)
  types.ts              ~34 LOC  Middleware types (existing)
```

### Provider Layer (~900 LOC, unchanged)

```
src/providers/
  provider.ts           ~84 LOC
  types.ts              ~71 LOC
  registry.ts           ~21 LOC
  acp/                 ~1300 LOC  AcpProvider + AcpClientManager + eventAdapter
  opencode/            ~120 LOC
  codebuddy/            ~25 LOC
```

### Utils (~400 LOC)

```
src/utils/  (existing utils + moved from claude/)
```

### Total: ~3,400 LOC (down from ~5,900 with dead code removed)
