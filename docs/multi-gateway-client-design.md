# Codever Multi-Gateway Client Architecture

## 1. Status

- Status: implementation in progress on `feature/multi-gateway-platform`
- Scope: product and system architecture
- Target: replace the Telegram-owned runtime with a remotely managed, multi-machine agent gateway
- Compatibility: this feature branch is a flag-day implementation. It reuses provider normalization where useful but does not require Telegram or the old daemon entrypoint to remain operational.

## 2. Executive Summary

The target system has three product components:

```text
Codever Client
  Web / PWA / Desktop / Mobile
             |
        HTTPS + WSS
             |
       Codever Relay
  identity / routing / durable sync
             |
       outbound mTLS WSS
             |
      Codever Gateway
 machine / projects / sessions / agents
             |
         ACP agents
```

The local Codever daemon becomes **Codever Gateway**. It remains the trusted execution boundary on each controlled machine. It owns local filesystem access, provider credentials, ACP processes, session execution, scheduling, MCP injection, and the authoritative local event journal.

**Codever Relay** is a public rendezvous, identity, routing, and optional replication service. Many Gateways connect to one Relay using outbound connections, so controlled machines do not need public inbound ports. Relay does not run coding agents and does not directly access a Gateway filesystem.

**Codever Client** is a single responsive TypeScript UI, distributed first as a Web/PWA application and then wrapped with Tauri 2 for desktop and mobile. It manages multiple Gateways, projects, and sessions. It consumes structured `ConversationEvent` values instead of Telegram-shaped messages.

Telegram is outside the first implementation. It may later return as an optional projection, but it is not a compatibility constraint or the identity/persistence model for a Codever session.

## 3. Goals

1. Control coding agents running on one or more remote machines.
2. Preserve the current always-on local gateway architecture.
3. Allow one Relay to accept multiple independently authenticated Gateways.
4. Give Web, desktop, and mobile clients one consistent UI and behavior model.
5. Display structured intermediate activity: tools, diffs, terminal output, plans, decisions, modes, and streamed assistant text.
6. Make machines, projects, sessions, and channel bindings first-class objects.
7. Persist a Codever-owned transcript so restored agent context and visible client history do not diverge.
8. Reuse the current semantic runtime and provider-normalization work.
9. Use standard transport and cryptographic protocols; do not design custom cryptographic primitives.
10. Support safe reconnect, replay, idempotency, revocation, and audit.

## 4. Non-Goals

1. Relay is not an ACP agent host.
2. Relay is not allowed to execute shell commands or read a Gateway filesystem directly.
3. V1 does not promise that Relay is unable to inspect content. TLS protects links; a trusted Relay terminates those links.
4. V1 does not migrate a live provider session between machines.
5. V1 does not implement multi-agent orchestration.
6. V1 does not expose arbitrary local directories merely because a remote user can type a path.
7. The client does not attempt to show hidden model reasoning that a provider does not emit.

## 5. Product Topology

### 5.1 Codever Gateway

One Gateway represents one controlled machine or isolated execution environment. It owns:

- registered project roots;
- provider profiles and provider credentials;
- ACP subprocess lifecycle;
- `SemanticSessionRuntime` instances;
- local session metadata and full `ConversationEvent` journals;
- scheduler and MCP-injected messages;
- permission enforcement and final decision resolution;
- Telegram adapter when enabled;
- the outbound Relay connection.

The Gateway is authoritative for execution state. Relay caches or replicates state, but may not claim that a command succeeded until the Gateway acknowledges it.

### 5.2 Codever Relay

Relay has a control plane and a data plane.

Control plane responsibilities:

- users, client devices, organizations/workspaces, and roles;
- Gateway enrollment, key registration, revocation, and status;
- Gateway/project/session inventory;
- authorization policy;
- audit logs;
- connection directory and routing.

Data plane responsibilities:

- multiplex client commands to the correct Gateway connection;
- forward live structured events to subscribed clients;
- acknowledge replicated events;
- optionally persist session event replicas and attachments;
- support reconnect and cursor-based catch-up.

Relay must not contain provider API keys or unrestricted filesystem credentials.

### 5.3 Codever Client

The client connects to Relay, not directly to ACP agents. It owns:

- Gateway/project/session navigation;
- structured conversation rendering;
- model, mode, provider, permission, and session controls;
- decision UI;
- uploads and downloads;
- local UI state and cached queries;
- client-device authentication.

An optional direct profile may connect the same client protocol to a Gateway on `localhost` or a trusted LAN. Direct mode is useful for development and offline use, but Relay mode is the primary remote-control topology.

## 6. Domain Model

### 6.1 Identity Hierarchy

```text
Workspace
  ├── User
  ├── ClientDevice
  └── Gateway
        └── Project
              └── Session
                    ├── Turn
                    ├── ConversationEvent
                    ├── Decision
                    └── ChannelBinding
```

All public IDs are opaque, globally unique IDs. Paths, Telegram chat IDs, provider session IDs, and display names are attributes, never primary identities.

### 6.2 Gateway

```ts
interface Gateway {
    id: string
    workspaceId: string
    name: string
    platform: 'windows' | 'macos' | 'linux' | 'container' | 'unknown'
    version: string
    capabilities: GatewayCapabilities
    status: 'online' | 'offline' | 'disabled' | 'revoked'
    connectionEpoch?: string
    lastSeenAt?: string
}
```

`connectionEpoch` changes on every accepted Gateway connection. Relay routes commands only to the current epoch, preventing an older connection from continuing after reconnect or split brain.

### 6.3 Project

A Project is a Gateway-approved root, not an arbitrary client-provided `cwd`.

```ts
interface Project {
    id: string
    gatewayId: string
    name: string
    rootPath: string       // visible only where policy permits
    canonicalRoot: string  // Gateway-local canonical path
    repoIdentity?: string
    defaultProvider?: string
    archivedAt?: string
}
```

Project roots are created locally or by an explicitly authorized remote operation. The Gateway canonicalizes paths and rejects traversal, symlink escapes where policy requires it, and paths outside configured allowlists.

### 6.4 Session

```ts
interface CodeverSession {
    id: string
    gatewayId: string
    projectId: string
    title?: string
    state: 'idle' | 'querying' | 'canceling' | 'offline' | 'closed' | 'error'
    provider: string
    providerSessionId?: string
    model?: string
    mode?: string
    config: Record<string, unknown>
    createdAt: string
    updatedAt: string
    lastEventSeq: number
}
```

`providerSessionId` remains opaque and Gateway-local. `CodeverSession.id` is the stable identity used by clients, Relay, Telegram bindings, scheduler, and MCP tools.

### 6.5 Channel Binding

Telegram becomes one binding to a session:

```ts
interface ChannelBinding {
    id: string
    sessionId: string
    type: 'telegram'
    externalKey: string // for example chatId:threadId
    notificationPolicy: 'all' | 'important' | 'completion' | 'none'
}
```

One session may have a UI subscription and a Telegram binding simultaneously. A Telegram topic may bind to at most one active Codever session.

## 7. Session Runtime Refactor

### 7.1 Current Constraint

The current runtime is wired around a single `ChannelPort`:

```text
TopicSession
  -> SemanticSessionRuntime
  -> ChannelProjector
  -> DeliveryOutbox
  -> TelegramPort
```

`SessionRecord` also contains Telegram identifiers. This prevents a session from naturally serving both a structured UI and Telegram.

### 7.2 Target Runtime

```text
ManagedSession
  -> SemanticSessionRuntime
  -> ConversationEventStore
  -> SessionEventHub
       ├── RelayReplicationSink
       ├── LiveClient subscriptions
       └── TelegramProjectionSink
              -> ChannelProjector
              -> DeliveryOutbox
              -> TelegramPort
```

The runtime records each semantic event once. Consumers choose their own projection:

- Client receives structured events.
- Telegram receives projected `ChannelMessage` values.
- Relay receives the versioned event envelope.
- Audit receives selected control events without sensitive payloads.

### 7.3 Decision Broker

`ChannelPort.requestDecision()` is replaced at the runtime boundary by a session-scoped `DecisionBroker`:

```text
Provider decision request
  -> DecisionBroker creates pending Decision
  -> event published to UI and Telegram
  -> first authorized valid response wins atomically
  -> DecisionBroker resolves provider callback
  -> later responses receive already_resolved
```

The Gateway is authoritative. Relay may coordinate UI state, but cannot resolve a provider decision by itself.

Decision records include expiry and allowed responders. Stale permission responses are never queued for later execution.

## 8. Event Storage and Transcript Semantics

### 8.1 Gateway Journal

The Gateway persists every accepted `ConversationEvent` to SQLite before reporting it as durable. Minimum key:

```text
(session_id, seq) unique
event_id unique
```

Each event envelope contains:

```ts
interface SessionEventEnvelope {
    schemaVersion: 1
    gatewayId: string
    projectId: string
    sessionId: string
    seq: number
    eventId: string
    timestamp: string
    event: ConversationEvent
}
```

`seq` is monotonically increasing within a Codever session. `eventId` provides global deduplication. Ordering is defined by `seq`, not wall-clock time.

### 8.2 Agent Context vs Visible Transcript

The system treats these as separate state:

- Provider context is restored through ACP/provider session APIs.
- Visible transcript is restored from Codever's event journal.

When a provider replays history during `session/load`, the provider adapter marks events as replay. The Gateway deduplicates known events where possible and records genuinely missing history without pretending that provider replay is a complete Codever transcript.

### 8.3 Relay Replication Policies

Relay supports workspace policy:

- `full`: replicate structured events and permitted attachments;
- `metadata`: replicate session metadata and event summaries only;
- `none`: live routing only; history requires an online Gateway.

`full` provides the best multi-device experience and is the recommended default for a self-hosted trusted Relay. The UI clearly indicates when offline history is unavailable under stricter policies.

Sensitive fields can be redacted by Gateway policy before replication. Provider credentials, environment secrets, and unrestricted raw process environments are never event payloads.

## 9. Connectivity and Protocols

### 9.1 Relay Selection

The user explicitly configures the Relay URL, for example:

```text
https://relay.example.com
```

The client and Gateway use normal TLS server certificate validation. Optional certificate/public-key pinning is available for private deployments but is not required for the default flow.

### 9.2 Gateway Identity

Each Gateway owns a distinct static private key generated or installed locally. Relay stores only the corresponding public key/certificate fingerprint.

Default connection:

- TLS 1.3;
- mutual TLS for Gateway-to-Relay authentication;
- ECDHE session key establishment;
- outbound `wss://` connection from Gateway;
- no globally shared PSK;
- private key stored in OS keystore/TPM when available;
- explicit revocation and rotation.

Static keys authenticate identities; ephemeral TLS keys encrypt each connection and preserve forward secrecy.

### 9.3 Gateway Enrollment

Two enrollment modes are supported.

Manual public-key enrollment:

1. `codever gateway init` generates the local key.
2. Gateway prints/exports a public enrollment bundle and fingerprint.
3. Administrator adds that public identity to Relay.
4. Gateway connects with mTLS.

Token-assisted enrollment:

1. Relay creates a short-lived, single-use enrollment token.
2. Gateway generates its key locally.
3. Gateway submits its public key with the token.
4. Relay registers the public key and invalidates the token.

The token is authorization to register a key; it never becomes the permanent machine identity.

### 9.4 Gateway Link

One long-lived WSS connection multiplexes control messages, commands, event replication, acknowledgements, and heartbeats.

```ts
interface GatewayFrame<T = unknown> {
    version: 1
    type: string
    messageId: string
    gatewayId: string
    connectionEpoch: string
    sessionId?: string
    idempotencyKey?: string
    payload: T
}
```

Initial message groups:

- `gateway.hello`
- `gateway.inventory.snapshot`
- `gateway.heartbeat`
- `session.event.batch`
- `session.event.ack`
- `command.request`
- `command.accepted`
- `command.result`
- `command.failed`
- `decision.response`
- `sync.request`
- `sync.complete`

The Gateway link is a Codever protocol, not raw ACP. ACP remains between Gateway and local provider so Codever can retain semantic normalization, scheduling, policy, and provider extensions.

### 9.5 Delivery Semantics

- Events: at-least-once delivery, deduplicated by `eventId` and `(sessionId, seq)`.
- Commands: at-least-once transport, exactly-once effect where supported through `idempotencyKey` and a Gateway command ledger.
- Live text/tool updates: ordered by session sequence.
- Reconnect: Relay and Gateway exchange last acknowledged cursors and resend gaps.
- Heartbeat: Relay marks Gateway offline after a bounded missed-heartbeat interval.
- Split brain: newest accepted `connectionEpoch` wins; old epochs cannot receive commands.

Relay never reports an execution command as completed merely because it accepted it for routing.

### 9.6 Offline Commands

Default policy:

- read cached history while Gateway is offline;
- reject execution mutations with `gateway_offline`;
- do not queue permission decisions;
- allow an explicit `send_when_online` user message with a visible TTL and cancel action;
- revalidate project/session state before executing a queued message.

This prevents surprising execution of stale destructive commands after a machine reconnects.

## 10. Client API

Relay exposes versioned HTTPS APIs for snapshots and mutations plus WSS for live updates.

Initial resource API:

```text
GET    /v1/gateways
GET    /v1/gateways/:gatewayId/projects
GET    /v1/projects/:projectId/sessions
POST   /v1/projects/:projectId/sessions
GET    /v1/sessions/:sessionId
GET    /v1/sessions/:sessionId/events?after=<seq>
POST   /v1/sessions/:sessionId/messages
POST   /v1/sessions/:sessionId/cancel
PATCH  /v1/sessions/:sessionId/config
POST   /v1/sessions/:sessionId/decisions/:decisionId
POST   /v1/sessions/:sessionId/attachments
POST   /v1/gateways/:gatewayId/projects
```

All mutations accept an idempotency key. Responses distinguish:

- accepted by Relay;
- accepted by Gateway;
- completed by Gateway;
- rejected;
- expired;
- unknown because the connection was lost before acknowledgement.

WSS subscriptions are scoped by authorized Gateway/session IDs and resume from cursors.

## 11. Authorization Model

Machine authentication and user authorization are separate.

Gateway authentication proves:

> This connection owns the registered private key for Gateway X.

User authorization proves:

> This user may perform operation Y on Project/Session Z.

Initial roles:

- `workspace_admin`: manage users, Gateways, enrollment, and policies;
- `gateway_admin`: manage one or more Gateways and project roots;
- `operator`: create/use sessions and answer permitted decisions;
- `viewer`: read replicated history and status only.

Provider permission modes do not override Relay authorization. A user who cannot send messages cannot indirectly invoke an unrestricted provider command.

Native clients may hold device-bound credentials. Web clients should use WebAuthn/passkeys or an external OIDC provider. Long-lived bearer tokens are not the default interactive login mechanism.

## 12. Security Boundaries

### 12.1 Trusted Relay V1

V1 protects both links with TLS, but Relay can inspect routed plaintext. This must be stated explicitly in product documentation.

Recommended deployment options:

- self-hosted Relay for source-sensitive environments;
- encrypted storage volumes and database backups;
- event retention controls;
- metadata-only or no-history replication;
- audit access to replicated content;
- no content in infrastructure logs.

### 12.2 Optional E2EE Later

An optional future mode may encrypt payloads between authorized client devices and Gateway using a reviewed standard construction such as HPKE. Relay would retain routing metadata but not event content.

This is deferred because multi-device key distribution, history sharing, device revocation, search, previews, and attachment encryption require a separate complete design. TLS/mTLS must not be described as Relay-blind E2EE.

### 12.3 Filesystem Safety

- Remote clients select registered `projectId`, not arbitrary paths.
- Gateway canonicalizes every filesystem target.
- Project policy controls whether symlinks may leave the project root.
- File downloads/uploads have explicit size and type limits.
- Provider credentials never leave Gateway.
- Tool output and diffs follow replication/redaction policy.
- Every remote mutation records user, device, Gateway, project, session, command, timestamp, and result.

## 13. UI Information Architecture

### 13.1 Navigation

Desktop layout:

```text
┌ Gateways ─────┬ Projects / Sessions ─┬ Conversation ─────────┬ Inspector ┐
│ workstation ● │ codever              │ assistant/tool stream │ tool input│
│ server-01   ○ │  ├ session A         │                       │ diff      │
│ laptop      ● │  └ session B         │ composer              │ terminal  │
└───────────────┴───────────────────────┴───────────────────────┴───────────┘
```

Mobile layout uses the same routes and components with drill-down navigation:

```text
Gateway list -> Project -> Session list -> Conversation -> Event detail
```

Primary route identity:

```text
/gateways/:gatewayId/projects/:projectId/sessions/:sessionId
```

### 13.2 Gateway Views

- online/offline/revoked status;
- platform and Codever version;
- current connection and last seen;
- projects;
- running sessions;
- provider availability;
- enrollment, key rotation, and revoke controls for administrators;
- logs and diagnostics with secret redaction.

### 13.3 Project Views

- project identity and Gateway location;
- repository/worktree status where available;
- sessions sorted by activity;
- provider/model defaults;
- scheduled tasks;
- Telegram/channel bindings;
- project access policy.

### 13.4 Session Conversation

The timeline renders structured event cards:

- user messages and attachments;
- streamed assistant output;
- collapsible thinking/status content emitted by the provider;
- tool lifecycle grouped by stable `toolCallId`;
- file reads and searches;
- diffs with accept/context views where appropriate;
- terminal output with bounded virtualization;
- plans/todos;
- decisions and permission state;
- errors, cancellation, timeout, reconnect, and replay markers.

Model/provider/mode/session controls live in persistent UI surfaces, not messages in the conversation timeline.

### 13.5 Multi-Gateway Rules

- Every project and session visibly identifies its Gateway.
- A composer cannot accidentally switch Gateway while retaining draft attachments.
- Cross-Gateway search is allowed over Relay-replicated metadata/content according to policy.
- A session cannot silently change its owning Gateway.
- Creating a similar session on another Gateway is a new session, optionally seeded with a user-selected textual summary; it is not session migration.

## 14. Reusing ACP UI

ACP UI is useful as a reference or source under its license for:

- responsive conversation layout;
- tool call cards;
- permission dialogs;
- model/mode selectors;
- markdown and code rendering;
- Tauri/Web platform abstraction;
- mobile navigation patterns;
- protocol traffic inspector ideas.

Codever must replace or isolate ACP UI assumptions about:

- direct client-to-agent connections;
- client-owned ACP process lifecycle;
- locally stored agent configuration;
- a flat list of agents/sessions;
- filesystem access from the client device;
- session identity being sufficient without Gateway and Project identity.

Before copying code, record upstream commit, license, copyright notices, modified files, and dependency/security review. Prefer extracting reusable presentation components behind Codever-owned domain interfaces rather than forking the whole application and retaining two competing state models.

Recommended frontend stack:

- TypeScript;
- Vue 3 if maximizing ACP UI reuse, otherwise the team's established preferred framework;
- responsive PWA as the canonical UI;
- Tauri 2 wrappers for Windows, macOS, Linux, Android, and iOS;
- generated API types from versioned schemas;
- one shared event renderer and state model across platforms.

## 15. Relay Persistence

Suggested relational tables:

```text
workspaces
users
workspace_members
client_devices
gateways
gateway_keys
gateway_connections
projects
sessions
session_events
session_event_cursors
commands
decisions
channel_bindings
attachments
audit_log
```

Suggested storage:

- PostgreSQL for Relay metadata, commands, and replicated events;
- object storage for replicated attachments;
- SQLite on Gateway for authoritative local metadata and event journals;
- no distributed dependency for an initial single-node Relay;
- add a connection directory/pub-sub layer only when horizontally scaling Relay.

## 16. Failure Behavior

### Gateway disconnects during a turn

- Relay marks the connection unavailable after heartbeat timeout.
- UI retains last durable event and shows `connection lost; execution state unknown`.
- Relay does not synthesize turn completion.
- Gateway continues locally if the provider is still running.
- On reconnect, Gateway uploads missing events and current session state.

### Relay restarts

- Gateway reconnects with backoff and a new connection epoch.
- Gateway and Relay reconcile event cursors.
- Client reconnects and resumes from its last sequence.
- Idempotent commands are reconciled from the command ledger.

### Client disconnects

- Gateway execution continues.
- Relay/Gateway journals continue receiving events.
- Client resumes using the last observed sequence.

### Conflicting decisions

- Gateway transactionally accepts the first valid response.
- All subscribers receive the final resolved decision event.
- Other responses return `already_resolved`.

## 17. Implementation Sequence

Implementation is isolated in a dedicated worktree and feature branch. It may replace old composition roots directly because the currently running Telegram deployment remains on the untouched main branch.

### Phase 1: Generic session identity

- Introduce `CodeverSession.id`, `gatewayId`, and `projectId`.
- Move `groupChatId` and `messageThreadId` out of core session metadata into `ChannelBinding`.
- Evolve `TopicSession` toward `ManagedSession` while preserving compatibility adapters.
- Make scheduler and MCP APIs target `CodeverSession.id` first.

### Phase 2: Durable semantic journal

- Add SQLite `ConversationEventStore`.
- Add an event sink callback to `SemanticSessionRuntime.record()`.
- Assign durable per-session sequence numbers.
- Add transcript snapshot/cursor APIs.
- Keep Telegram projection unchanged.

### Phase 3: Local Gateway API

- Replace the localhost-only MCP HTTP server as the sole API surface with a versioned internal/public Gateway API.
- Keep MCP IPC bound to localhost and separately authenticated from remote client APIs.
- Add project registry and filesystem policies.
- Add structured session commands and live event subscriptions.

### Phase 4: Relay and Gateway Link

- Implement Gateway identity/enrollment.
- Add outbound mTLS WSS link.
- Synchronize inventory, events, commands, and cursors.
- Add Relay authorization and audit.

### Phase 5: Web/PWA Client

- Implement Gateway/project/session navigation.
- Render structured event history and live updates.
- Implement decisions, model/mode/provider controls, uploads, and reconnect.
- Use ACP UI patterns/components where license and architecture fit.

### Phase 6: Native Packaging

- Package the same UI with Tauri 2.
- Add secure device credentials, deep links, notifications, and platform file pickers.
- Ship desktop first if signing capacity is limited, then Android and iOS.

### Optional Later Phase: Telegram as a Binding

- Let users bind/unbind a Telegram topic from the Codever UI.
- Add notification policies per binding.
- Ensure both UI and Telegram observe the same session and decision state.
- Remove remaining assumptions that one Telegram topic is the owner of a runtime session.

## 18. Architectural Invariants

1. One live Codever session executes on exactly one Gateway.
2. One Gateway owns the authoritative execution state and local journal for its sessions.
3. Relay never executes agent tools or accesses local files directly.
4. Provider events are normalized before any channel or client rendering.
5. UI consumes structured semantic events; Telegram consumes a projection.
6. Provider credentials remain on Gateway.
7. Every Gateway has an independent static machine identity key.
8. Static keys authenticate; ephemeral TLS keys protect connection data.
9. Relay command acceptance is not execution completion.
10. Commands and events are idempotent/deduplicated across reconnects.
11. Project roots are explicit Gateway resources, not arbitrary remote paths.
12. Provider context and visible Codever transcript are separate persisted concepts.
13. Telegram bindings do not define session identity.

## 19. Initial Decisions

The following decisions are accepted for the first implementation plan:

1. Preserve Codever Gateway as the local always-on execution service.
2. Add a separately deployable Relay that supports multiple Gateways.
3. Relay URL is explicitly configured by the user.
4. Use TLS 1.3 and per-Gateway static machine keys with mTLS; do not use a global shared PSK.
5. Treat Relay as trusted with plaintext access in V1 and document that boundary.
6. Use a Codever-specific Gateway/Client protocol rather than exposing raw ACP through Relay.
7. Persist normalized `ConversationEvent` journals on Gateway.
8. Make Relay event replication configurable, recommending full replication for self-hosted Relay.
9. Build one TypeScript responsive UI and package it for multiple platforms.
10. Retain Telegram as an auxiliary binding.

## 20. Open Product Decisions

These decisions do not block the core architecture but must be resolved before implementation reaches the relevant phase:

1. Whether hosted Relay is in scope or only self-hosted Relay.
2. Default replicated-history retention and attachment limits.
3. Whether workspace multi-user collaboration is V1 UI scope or only an authorization-ready backend model.
4. Whether the first native release targets desktop before mobile.
5. Whether to adopt Vue 3 to maximize ACP UI reuse or use another frontend framework.
6. Whether optional direct-to-Gateway mode ships in V1.
7. Whether optional Relay-blind E2EE is a planned milestone or only an extension point.
