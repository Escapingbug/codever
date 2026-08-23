# Codever Matrix/PWA architecture

Status: CVP/3 implementation

Codever is an ACP coding-agent client built on Matrix. Matrix provides durable
encrypted store-and-forward, multi-device sync, room/thread history, and media;
it is not execution authority and is not used as an application RPC queue.

## Product shape

- A Gateway runs beside the coding agents on a workstation or server.
- The same online-updatable PWA is the UI in desktop browsers and inside the
  first-party Android shell.
- The Android foreground connection service owns durable background Matrix
  sync, command reconciliation, local projection, and task notifications.
- A workspace is organized as project rooms; one encrypted room is exactly one
  project and each Agent session is an `m.thread` in that room.
- Future desktop shells may reuse the PWA and native-service boundary without
  moving the web application into a separately updated offline bundle.

## Runtime shape

```text
PWA or Android native service
  -> durable signed/encrypted CVP/3 command event
  -> Matrix project-room timeline
  -> MatrixCvp3GatewayRunner
  -> durable command journal / authorization
  -> TopicSession -> SemanticSessionRuntime -> AgentProvider
  -> ConversationEvent
  -> signed/encrypted CVP/3 Gateway event
  -> durable Matrix outbox
  -> Matrix project thread
  -> client raw inbox -> verified local projection -> UI / notification
```

Edits, redactions, membership changes, Matrix state power, and ordinary Matrix
text never directly mutate local execution state. Only a Codever command signed
by a currently certified device and accepted by the Gateway journal can do so.

## Room and session model

```text
Gateway workspace
  └─ project room <-> projectId <-> fixed Gateway working directory
       └─ session root <-> m.thread <-> TopicSession
```

Project display names need not be unique, but project IDs and room bindings are.
A session stores its provider binding, model/reasoning configuration, lifecycle,
thread root, and immutable project ID. It cannot move between rooms.

Every active session owns its own `TopicSession`, `SemanticSessionRuntime`, and
provider instance. Sessions may execute concurrently. Selecting a conversation
is client-local view state and never suspends another session or mutates a
Gateway-wide “current session”. Archive releases runtime resources while
retaining metadata; restore recreates them; delete writes an authenticated
tombstone but does not claim to erase Matrix or provider-retained history.

Sensitive fields—including paths, prompts, Agent output, tool arguments,
provider session IDs, credentials, and execution grants—remain inside Codever
application encryption. Matrix-visible room names and message bodies are
non-sensitive placeholders.

## Protocol layers

1. Pairing pins the Gateway application key, Matrix transport binding, device
   identity, and command certificate. Pairing and Gateway transport rotation
   form an independently versioned pre-trust control plane.
2. The Gateway directly grants each trusted device the current project key ring
   through addressed `io.codever.project.key_grant.v3` Room State.
3. Commands and Gateway outputs use the same CVP/3 application envelope in
   ordinary `m.room.message` timeline events.
4. A device signature authorizes an exact command. A Gateway signature proves
   an exact acknowledgement, lifecycle transition, Agent/tool event, snapshot,
   or terminal result.
5. Application encryption binds workspace, project, room, key epoch, logical
   ID, nonce, and ciphertext. A homeserver cannot relocate or rewrite a signed
   relation without rejection.
6. Logical event identity is independent of the physical Matrix event ID.
   `causationCommandId` is a relationship, never message identity.
7. The client saves exact outbound content before send and reuses a stable
   Matrix transaction ID. Matrix acknowledgement stops retransmission; terminal
   convergence comes from the signed Gateway chain.
8. The Gateway journals a command before execution. Redelivery of the same
   command ID returns its recorded state and cannot execute twice.
9. Current project state is an ordinary signed snapshot referenced by
   `io.codever.project.current.v3`. It is a recovery accelerator, not a separate
   mutable authority or a manual checkpoint.
10. `/sync` is the sole normal source of recent events. Clients commit its
    cursor only after durable inbox/projection handling; a limited timeline
    creates a durable background gap-recovery job. Thread relations are used
    only to establish a cache-cold selected window and to page older history.
11. Clients persist a raw event before projection. Poison is quarantined per
    event and dependency-deferred records converge in multiple passes.
12. CVP/1 and CVP/2 application events are neither emitted nor parsed by
    production Gateway, PWA, or APK entry points. There is no negotiated data
    downgrade.

The normative wire and recovery rules are in
[`codever-protocol.md`](codever-protocol.md).

## Android ownership boundary

The native foreground service remains connected while the Activity/WebView is
backgrounded. It owns:

- Matrix login, `/sync`, thread pagination, and media transfer;
- encrypted identity, trust, project keys, raw inbox, projection, and outbox;
- exactly-once command reconciliation across process death;
- notification emission when an Agent task reaches a user-relevant result;
- versioned store migrations before connection starts.

Native application releases are account state owned by the Gateway. Deployment
stores an immutable APK first, then submits its metadata to the owner-only
Gateway admin socket. The Gateway persists the latest release and includes it
in the ordinary signed, encrypted `workspace.snapshot`; offline devices receive
only that latest state when Matrix synchronization resumes. Android verifies
the APK hash, package identity, monotonic version, architecture, and application
signing certificate before `PackageInstaller` can replace it. Downloads are
resumable and rebuildable; Matrix tokens, trust, commands, and history never
enter update storage. There is no public update manifest or second update key.

The WebView subscribes to a versioned native bridge and renders service-owned
state. Detaching, reloading, or online-updating the PWA cannot cancel a running
Agent or create a second Matrix client. Browser-only use implements the same CVP/3
projection in IndexedDB. It cannot keep Matrix `/sync` executing after the
browser suspends it, but an opted-in standards-based Web Push subscription lets
the Service Worker wake for a generic task-terminal system notification.

## Browser Web Push boundary

```text
durable turn.completed / turn.failed
  -> Gateway Web Push outbox (dedupe + retry)
  -> browser push service (VAPID + encrypted payload)
  -> PWA Service Worker
  -> system notification -> #session=<id>
```

The PWA registers or removes only its own subscription through encrypted,
signed CVP/3 commands. The Gateway persists one subscription per Codever device
and a stable VAPID key pair beside the replay ledger. Push is an attention
signal, not another conversation transport: the payload contains only bounded
workspace/project/session routing IDs and terminal status, and the UI still
loads and verifies the result from Matrix. Visible clients receive a lightweight
Service Worker message and suppress the duplicate system popup. Expired 404/410
subscriptions are removed; transient delivery remains in the outbox. A bounded
Service Worker `eventId` cache absorbs the residual duplicate case where a push
provider accepted delivery immediately before the Gateway process stopped.

## Attachment and artifact flow

Matrix media is storage only. A sender encrypts every attachment with a fresh
AES-256-GCM key before upload and signs the `mxc://` locator, key, IV, hashes,
name, MIME type, and bounded size inside the application event. The Gateway
downloads only signed descriptors, enforces limits, authenticates/decrypts the
bytes, and converts supported media to ACP rich content. Explicit `send_file`
is the only Agent-to-client local-file delivery authority.

## Delivery and recovery ownership

- Gateway command journal: deduplication and execution outcome.
- Gateway Matrix outbox: exact content, ordering, retry-after, transaction ID.
- Client durable command outbox: intent and Matrix-send reconciliation.
- Client raw inbox: crash-safe receipt before verification/projection.
- Client projection: rebuildable sessions, messages, lifecycle, and snapshot.
- Matrix timeline/threads: durable cross-device history and audit.

The UI reads only the local projection. A session `updatedAt` change, browser
focus, visibility change, or network recovery never synchronously reloads its
recent thread relations. Live `/sync` events update the projection directly;
explicit gap workers and user-requested older pagination are the only recovery
paths allowed to read remote history.

No layer substitutes for another. In particular, increasing an in-memory event
window, publishing a manual checkpoint, or resending an already Matrix-acked
command is not a recovery strategy.

## Release acceptance

A release that changes this vertical slice is not accepted on unit tests alone.
The real Synapse Alpha journey must pair two browsers and an installed isolated
APK, create and run concurrent sessions, receive background completion and a
notification, survive Android process restart, restore history, quarantine a
malformed event without blocking later data, converge across devices, and
delete sessions concurrently. See [`real-matrix-testing.md`](real-matrix-testing.md).
