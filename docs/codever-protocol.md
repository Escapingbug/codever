# Codever Protocol (CVP/3)

Status: version 3, pre-release hard cutover

**Codever Protocol (CVP)** is Codever's signed, encrypted application protocol.
The current version is written **CVP/3**. Matrix is its durable transport; a
Matrix room/event/sync version and a CVP version are separate concepts.

## Naming boundary

- **CVP/3 command, event, envelope, projection, key, or snapshot** means a
  Codever application-protocol object.
- **Matrix room, event, thread, state, sync, E2EE, or rate limit** means a
  transport object or behavior.
- A code symbol named `MatrixCvp3*` is specifically a Matrix transport adapter
for CVP/3; it does not name a version of Matrix.

Workspace-level semantics are explicit in payloads. Scratch sessions use
`session.create.scope = "scratch"`; received files use
`inbox.file.received` without a `sessionId`. A project ID may still be present
as the authenticated Matrix-room routing binding, but clients must not present
either entity as owned by that project. A workspace inbox event is replicated
once per active project room using the same logical file and event IDs.
- Existing wire event types ending in `.v3`, encrypted-storage domain strings,
  and database filenames remain unchanged because they are compatibility IDs.

Codever uses Matrix as a durable encrypted conversation log. Matrix is not an
RPC queue and a client cache is never authoritative. The homeserver is trusted
for availability and ordering only; Codever signatures establish authorship
and application encryption hides business content from the homeserver.

CVP/3 replaces the pre-release CVP/1 and CVP/2 application data planes. There is no
wire downgrade, checkpoint RPC, state-request RPC, history-request RPC, or v2
timeline fallback. The pairing handshake has its own version and remains only
as the control plane that establishes device trust and distributes CVP/3 keys.

## Native object mapping

| Codever concept | Matrix concept | Authority |
| --- | --- | --- |
| Workspace | a set of encrypted project rooms | local Gateway configuration plus signed room membership |
| Project | one encrypted Matrix room | `project_id` permanently bound to the room |
| Session | one Matrix thread | immutable root event and signed lifecycle events |
| User prompt or mutation | ordinary `m.room.message` command event | device signature, certificate, stable `command_id` |
| Agent/tool/status output | ordinary `m.room.message` thread event | Gateway signature and stable logical `event_id` |
| Current project projection | ordinary signed snapshot event | `io.codever.project.current.v3` points to its physical event ID |
| Project key grant | directly addressed Room State | `io.codever.project.key_grant.v3` keyed by device ID |
| Transcript and audit | thread timeline and relations | append-only signed events |

One room represents exactly one project. Project identity therefore does not
need to be repeated as visual grouping metadata in every session row, and a
session cannot silently move between projects. Matrix Spaces may organize
rooms later without changing the room/thread protocol.

## Unified event chain

All business commands and Gateway outputs are normal timeline events. Their
outer `io.codever` object contains CVP version 3, the logical event ID,
project binding, key epoch, nonce, and application ciphertext. The decrypted
payload is either a device-signed command or a Gateway-signed event.

Every signature binds the workspace, project, room, certificate generation,
logical ID, operation/kind, timestamp, and payload. A Matrix physical event ID
is delivery metadata, not business identity. Moving ciphertext to another
room, changing a relation, changing a command, or substituting a logical ID
fails verification.

`causationCommandId` records why a Gateway event exists. It is not the event's
identity: a prompt, acknowledgement, Agent response, tool result, and terminal
result may all causally refer to one command while retaining distinct logical
event IDs. Clients only reconcile the optimistic user prompt with its canonical
user event; they never merge an Agent response into that prompt. A projected
user event MUST retain its originating device ID so the client can select the
exact optimistic entry even when the durable local projection emits before
`send()` returns. That authoritative projection updates the selected entry's
delivery state in place.

## Commands and exactly-once execution

Before sending, a client writes the exact signed and encrypted Matrix content
to its durable outbox. Retry reuses both `command_id` and Matrix transaction ID.
Once Matrix acknowledges the event, the client stops retransmitting it and
waits for the signed Gateway chain to reach acknowledgement and terminal state.

The Gateway commits each accepted `command_id` to a durable command journal
before execution. Re-delivery returns the recorded state and never runs the
operation twice. Independent append operations such as prompts are serialized
by the Gateway; state-dependent mutations carry explicit preconditions and
produce a reviewable conflict instead of hidden client-side retry.

Session creation, prompt, cancel, settings, provider-history inspection, and
archive use this same path. A create command produces an immutable thread root.
The provider is selected only by `session.create` and is immutable for the
life of that Codever session. `session.update` may change model and reasoning,
which the Gateway applies through the provider's structured ACP model/config
surface rather than manufacturing provider-specific slash commands.

`project.update` stores the default model and reasoning used by later sessions
for the project's default provider. Provider-native slash commands remain user
messages. When ACP publishes `available_commands_update`, clients may render
those commands as actions that insert the corresponding slash input; Codever
does not take ownership of provider commands such as `/model`.

Provider-owned history is a separate surface. `provider.sessions.list` lists
the sessions still retained by a configured provider and
`provider.session.inspect` returns a bounded read-only transcript preview.
Creating a session with `providerSessionId` adopts that existing provider
conversation; the first message sent from the preview is carried as the create
command's initial prompt. A provider session already managed by an active
Codever session opens that session instead of creating a duplicate.

Codever has one removal action: archive. It removes a session from the managed
session projection but retains its metadata tombstone and never invokes a
provider-level delete. Archived sessions are not restored in place; if the
provider still lists the conversation, users continue it from Provider
History, producing a new Codever session identity. Pre-release `delete`
requests are normalized to archive and `restore` is rejected for compatibility;
neither redacts Matrix or provider history.

Browser notification enrollment also uses this path. A web device sends
`notification.subscribe` or `notification.unsubscribe` as a signed,
project-encrypted CVP/3 command. The subscription is scoped to the authenticated
`deviceId`; a command cannot install or remove another device's endpoint. The
Gateway advertises its stable VAPID public key in the optional `web_push`
capability and acknowledges the change with
`notification.subscription.changed`. Existing `session.settings` certificate
authority covers this device-local setting, so adding the optional capability
does not invalidate an already paired device.

## Current state and recovery

Current state is an optimization over the event log, not a second authority.
After a projection change, the Gateway emits an ordinary signed project
snapshot and updates `io.codever.project.current.v3` to that event. A cold
client reads the pointer, fetches and verifies the referenced event, then
enumerates Matrix threads with complete pagination. It loads a selected
transcript's initial window through standard thread relations only when the
local projection has no cached window. Older transcript pages are loaded on
explicit user pagination.

Clients persist raw Matrix events before projection. Projection success marks
an inbox record complete. A malformed event is quarantined individually; it
cannot block later valid events. Events that are valid but await a dependency,
such as a project key grant, are retried in multi-pass order so a later grant
can unlock an earlier event without deadlocking the inbox.

The `/sync` token is the incremental Matrix transport cursor, not a CVP
checkpoint. A client advances it only after every accepted event has completed
its durable local transition or has been quarantined as poison. If `/sync` is
limited, the client persists the exact gap boundary before advancing the live
cursor and closes that gap in a coalesced background worker. The current
pointer and fully paginated thread directory provide a cache-cold baseline;
thread relations do not poll for recent state. Process death resumes the
durable inbox, gap queue, and outbox and never manufactures a replacement
command.

Offline clients show their last verified encrypted local projection and
history. They do not report Connected or release new commands until the Matrix
transport and authenticated CVP/3 projection are writable.

Android owns this process in its foreground connection service. The service
keeps `/sync`, raw-inbox persistence, projection, outbox reconciliation, and
task notifications running while the WebView is detached or the screen is
off. Opening the Activity reads the service-owned projection; it does not start
a separate catch-up protocol. Gateway/session timestamps, WebView focus, and
network visibility are never reasons to rescan recent thread history.

Browser-only PWA installations use standards-based Web Push when the user opts
in. The Gateway persists its VAPID key pair, per-device subscriptions, completed
event IDs, and a retrying notification outbox. `turn.completed` and
`turn.failed` are enqueued only after the command terminal is durable. Web Push
payload encryption protects a small routing payload in transit; it contains no
prompt, Agent output, session title, path, or attachment. A Service Worker may
wake while the PWA is closed, show a generic system notification, and route a
click to `#session=<id>`. A visible PWA suppresses the duplicate system popup
and the Service Worker persists a bounded `eventId` dedupe set. The UI continues
to use the authenticated Matrix projection as the source of truth. HTTP 404/410
responses remove expired endpoints; transient failures stay in the durable
outbox for retry.

## Encryption and device lifecycle

Matrix E2EE protects the Matrix transport. CVP/3 additionally encrypts project
payloads with a durable AES-256-GCM project key ring. The Gateway sends
one pairwise encrypted `io.codever.project.key_grant.v3` state event for each
trusted device. A client ignores grants addressed to other devices; they are
normal room state, not poison input.

Adding a device grants the retained project epochs needed for authorized
history. Revocation rotates the active epoch. A removed device may retain data
it legitimately decrypted earlier but cannot decrypt later events. Pairing
responses/rejections and signed Gateway Matrix-device rotation remain
pairwise control messages; they do not carry application session state.

Large attachments are encrypted before Matrix media upload and referenced by
signed metadata. Large visible text is split into deterministic bounded parts
with one logical message identity so recovery never depends on an oversized
single response.

## Rate and delivery budget

Traffic scales with visible business activity:

- one Matrix command event per user action;
- one acknowledgement and one terminal event per command;
- Agent/tool events or edits that are actually visible;
- one snapshot event plus one pointer replacement when the current projection
  materially changes;
- one pairwise key-grant state event only when a device or key epoch changes.

There is no per-device fan-out for ordinary conversation output, heartbeat
state, focus refresh, reconnect RPC, session-directory page rewrite, or manual
checkpoint publication. Gateway and client outboxes honor Matrix `retry_after`
and stable transaction IDs, so homeserver rate limits affect latency rather
than correctness.

## Cutover invariants

- Production Gateway entry points instantiate only `MatrixCvp3GatewayRunner`.
- PWA production connection uses only `connectMatrixCvp3`.
- Android business projection accepts only CVP/3 project events. It does not
  parse CVP/2 Room State, `secure_envelope`, `secure_envelope_bundle`, or
  `timeline_envelope` as application data.
- No production composition root imports, emits, parses, or negotiates a CVP/1 or CVP/2
  application data event.
- Unsupported authenticated versions fail closed; they are never reinterpreted
  through another codec.
- Full Alpha acceptance requires disposable Synapse, two browser devices, a
  real installed Android target, Gateway restart-safe stores, background Agent
  completion and notification, reload/history restore, poison quarantine,
  cross-device convergence, and concurrent deletion.
