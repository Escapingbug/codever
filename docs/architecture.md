# Codever architecture

> This document describes the currently implemented Matrix/Gateway runtime.
> The approved next-stage product model, UI journeys, Task workspaces and plugin
> boundaries are specified in
> [`product-design-next.md`](./product-design-next.md). Machine migration and
> session reconstruction should start with
> [`migration-handoff-2026-07-21.md`](./migration-handoff-2026-07-21.md).

## Purpose

Codever lets native mobile and desktop clients continue ACP-compatible coding
sessions running on remote computers. It preserves provider-native sessions,
projects, tools, decisions and model controls without forcing them through a
chat-platform UI.

## Runtime shape

```text
Vue/Tauri client
  -> native matrix-sdk crypto store
  -> encrypted Matrix timeline and to-device verification
  -> stock Synapse store-and-forward server
  -> native matrix-sdk Gateway sidecar
  -> MatrixGatewayWorker
  -> AuthorizedRequestProcessor (COSE Sign1/CWT)
  -> GatewaySessionService
  -> AgentProvider / ACP
  -> normalized GatewayConversationEvent
  -> encrypted Matrix conversation event
  -> client cache and semantic UI
```

Matrix is the synchronization protocol, not the execution authority. Gateway is
the only component allowed to start providers, access project files or resolve
provider decisions.

## Trust and protocol layers

### Matrix identity and synchronization

The official Rust `matrix-sdk` owns:

- password login and refresh-token rotation;
- persistent SQLite crypto stores;
- Olm/Megolm encryption and decryption;
- cross-signing and SAS device verification;
- durable timeline synchronization, redelivery and transaction IDs.

The native boundary exposes only whitelisted `io.codever.*` events. Gateway
commands from plaintext or unverified devices are discarded before business
parsing.

### Execution authorization

Matrix verification alone cannot run a command. The client signs a short-lived
COSE Sign1 token containing CWT claims for:

- issuer and client/device subject;
- target Gateway ID;
- exact operation;
- hash of the exact request;
- issued-at, not-before, expiry and unique token ID.

`AuthorizedRequestProcessor` verifies the token against Gateway-local execution
roots, applies a persistent replay guard, then enters `GatewayRequestLedger`.
Only this path may call Gateway business handlers. Root trust/revocation is also
an authorized operation, so an existing root can approve another client without
server-host access.

### ACP business protocol

`@codever/protocol` defines strict schemas for inventory, projects, sessions,
events, decisions, files and authorized client/Gateway frames. ACP remains the
provider protocol behind Gateway; Matrix does not carry provider-specific raw
events directly to UI.

## Main components

### Native Matrix transport (`crates/matrix-transport`)

Shared by Gateway and Tauri. It restores one Matrix device, runs sync, sends raw
whitelisted Codever events, reports encryption verification metadata, lists
devices and drives the SDK SAS state machine. The Gateway process talks to it
through bounded JSON-line RPC; Tauri links the library directly.

### Gateway composition (`src/gateway/gatewayApplication.ts`)

Creates the project registry, session service, event store, attachment store,
request ledger, execution trust repository, replay guard and Matrix worker. It
publishes Gateway presence and inventory, and projects session events into the
encrypted timeline.

### Matrix Gateway worker (`src/gateway/matrix`)

Consumes only encrypted events from verified devices. Discovery is separate from
authorization and only reveals encrypted Gateway inventory. Command responses
and semantic conversation events use stable transaction/event IDs so redelivery
converges.

### Authorized request processor

This is the sole boundary from untrusted store-and-forward input into Gateway
business logic. It fails closed on malformed tokens, unknown/revoked keys,
wrong target or operation, altered requests, expiry, clock skew and replay.

### Gateway session service

Owns project/session metadata and provider lifecycle. Opening history never
marks a session active; only an accepted interaction does. Provider-native
sessions can be discovered and attached without creating duplicate Codever
sessions for each turn.

### Client API (`apps/web/src/api`)

`NativeMatrixClient` owns native Matrix calls. `MatrixGatewayClient` signs and
correlates authorized requests, discovers Gateways and deduplicates timeline
events. `CodeverApi` presents project/session/file operations to Vue and tracks
Gateway routing without exposing transport details to views.

### Client state and cache

The native session and execution private key live in platform credential storage;
public routing metadata lives in local application state. Session lists and
conversation history are cached independently of network state. Cached content
opens immediately, recent live events merge by stable IDs and older history is
loaded progressively without moving the visible scroll anchor.

### Semantic UI

User and Agent messages are the primary transcript. Markdown is rendered as it
streams. ACP lifecycle events become reply state, tool cards and decision UI;
they are not dumped into the conversation as raw messages. Slash-command-only
operations such as model/mode changes, stop, archive and decisions use native UI
controls.

## Room/event model

One encrypted control room carries all Codever transport events for the Matrix
account. Gateway, Project and Session IDs are encrypted payload fields rather
than Matrix rooms or threads. This minimizes homeserver-visible topology and
avoids coupling business state recovery to room provisioning. COSE/CWT still
authorizes the exact target Gateway and operation independently of room access.

Event types and setup are specified in
[`matrix-transport.md`](matrix-transport.md).

## Reliability invariants

- Matrix transaction ID equals the stable Codever command/event identity.
- COSE replay storage prevents one signed token from being consumed twice.
- The request ledger returns the prior terminal result for repeated idempotency
  keys and never re-executes uncertain mutations.
- Accepting a provider turn does not block cancel, decision or another Session.
- Cached UI remains readable while Matrix and Gateway refresh are unavailable.
- History pages merge by event ID and preserve the viewport anchor.
- Token refresh is persisted to platform/Gateway credential storage.

## Source map

```text
crates/matrix-transport/        official Matrix SDK wrapper and sidecar
packages/execution-auth/        COSE Sign1/CWT signing and verification
packages/protocol/              strict ACP/business wire schemas
src/gateway/                    Gateway business runtime and persistence
src/gateway/matrix/             Matrix worker and sidecar client
src/gateway/security/           local execution trust and replay storage
apps/web/src/api/               native Matrix and Gateway API facades
apps/web/src/state/             login, cache and application state
apps/web/src/views/             native client UX
apps/web/src-tauri/             desktop/mobile shell and secure storage
deploy/matrix/                  unmodified private Synapse deployment
```

The former Telegram source may remain elsewhere in repository history, but it is
not a runtime path, protocol compatibility surface or deployment dependency of
this architecture.
