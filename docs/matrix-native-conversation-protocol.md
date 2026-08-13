# Matrix-native conversation protocol

Status: protocol version 2

Codever uses Matrix as the durable conversation log, not as an RPC queue. The
homeserver remains untrusted for business plaintext and execution authority.

## Native object mapping

The session/thread mapping is normative in version 2. Space-based discovery is
the target topology for aggregating several configured project rooms; it is not
required to stop using Gateway RPC for state or history.

| Codever concept | Matrix concept | Durable identity |
| --- | --- | --- |
| Gateway workspace | Space | Space room ID |
| Project | encrypted room | room ID plus signed project ID |
| Session | `m.thread` | immutable `session_root` event ID |
| User/agent/tool output | thread reply | Matrix event ID plus signed logical ID |
| Archive/status/delete | thread lifecycle event | Matrix event ID |
| Capabilities/revision epoch | encrypted checkpoint | monotonically increasing state version |

The current deployment continues to bind one configured encrypted room at a
time. It may contain several project identities, and each session root keeps
its signed project ID/name/path. A later topology migration can split those
projects into separate encrypted rooms under one Space without changing thread
semantics or the version-2 event format.

## Event model

`session_root` is emitted exactly once with a stable Matrix transaction ID. It
contains the initial session summary and becomes the thread root. Every later
message, decision, status, `session_update`, and `session_lifecycle` event is
bound to that root. Archive and delete do not redact Matrix history.

`gateway_checkpoint` carries revision epoch, current revision, workspace
defaults, capabilities, and active-device count. It deliberately does not
carry a session inventory. Clients project the inventory from session roots
and lifecycle events. Command results advance the known revision, so a
checkpoint is not emitted after every command.

Every native session root/update/lifecycle event also carries the conversation
revision and epoch that produced it. The collaboration prompt carries the same
metadata immediately, before agent execution finishes. Commands without a
corresponding session event (`cancel`, `decision`, invitation, failed commands,
and idempotent delete) emit a small `gateway_revision` room-timeline event.
Thus every device observes the authoritative cross-device order without a
state request or a full checkpoint per command.

Clients restore data through native Matrix APIs:

- `/sync` for live and cached events;
- `/threads` for session inventory;
- `/messages`/SDK backward pagination for older timeline data;
- the SDK's local encrypted store for offline display.

The removed pre-release `gateway_state_request` and `history_request` RPCs have
no compatibility path. The Gateway neither accepts those requests nor emits
their response events, and clients do not parse them.

## Application encryption

Matrix E2EE protects transport, while Codever application encryption prevents
a malicious or compromised homeserver from reading Codever content.

Each project room has a durable AES-256-GCM timeline key ring. A timeline event
contains:

1. one Gateway-signed group ciphertext containing the complete Matrix message;
2. a pairwise encrypted key-ring bundle addressed to currently authorized
   Codever devices;
3. the standard `m.relates_to` value outside the application ciphertext so the
   homeserver can implement thread aggregation.

The signed envelope binds gateway, conversation, room, key epoch, session,
thread root, logical event ID, nonce, and issue time. Clients require the outer
Matrix relation to equal the relation inside the signed ciphertext. Moving an
event between rooms, sessions, or threads therefore fails authentication.

The key-ring bundle is carried in the same Matrix event, so one business output
always costs one Matrix send regardless of device count. A newly authorized
device receives all retained epochs in the next event and can then paginate old
Matrix history. Adding a device does not rotate the active epoch; removing or
revoking any device does. Removed devices retain plaintext they legitimately
saw before revocation but cannot open later epochs.

Matrix caps a complete event at 65,536 bytes. Codever therefore retains at most
64 timeline epochs and rejects an application event before delivery if its
canonical pre-Megolm content exceeds 40 KiB, leaving room for Megolm and
federation metadata. Exhausting the epoch budget is an explicit room-migration
condition; keys are never silently discarded because that would make old
history appear complete while actually becoming unreadable.

Commands, acknowledgements, results, conflicts, and invitation control remain
pairwise signed/encrypted because they are device-specific and executable.
Command authorization still requires device certificate, Matrix transport
binding, sequence epoch, and replay ledger checks. The conversation revision
orders every accepted command; it is a strict compare-and-swap precondition
for state-dependent mutations, while a stale append-only prompt whose missing
revisions are also prompts is assigned the next revision by the Gateway.

Client command recovery separates durable command identity from transport
delivery. The command ID, sequence, base revision, payload, authentication
timestamp, and nonce remain stable until acknowledgement, while every retry
uses a fresh Matrix transaction ID and a fresh outer secure envelope. This
prevents homeserver transaction deduplication and envelope replay protection
from hiding a recovery attempt, while the Gateway replay ledger guarantees
that the business command executes at most once and re-delivers its journaled
result. Unversioned pre-upgrade ledger entries may only return an already
journaled result; their retry payload is never executed.

## Delivery and rate budget

Timeline delivery is staged in `FileMatrixDeliveryOutbox` before the network
attempt and retried with the same Matrix transaction ID. An embedded key-ring
bundle and its timeline ciphertext succeed or fail atomically as one request.

Steady-state costs are based on user-visible semantics rather than internal
state reads:

- one user command event;
- one collaboration/thread event for the user's prompt;
- agent messages/edits that are actually visible;
- a targeted acknowledgement and terminal result where required;
- no Gateway history/state request on connect, focus, scrollback, or reconnect.

This removes the previous request/page/state amplification and keeps normal use
compatible with homeservers configured for human-chat rate limits. Client and
Gateway schedulers still honor `M_LIMIT_EXCEEDED` retry timing; raising server
limits is not a correctness requirement.

## Client recovery algorithm

1. Start Matrix sync and restore its encrypted local store.
2. Authenticate the pinned Gateway application key and transport binding.
3. Read the newest key-ring bundle available to the device.
4. Fetch thread roots and the newest checkpoint; project the session list.
5. Process live events idempotently by Matrix event ID and signed logical ID.
6. On a limited sync or foreground return, paginate Matrix and re-project; do
   not contact the Gateway for a snapshot.
7. When history is requested, serve local events first and paginate backward
   until the page is full or Matrix reports the start of history.
8. Offline, display the locally persisted projection and transcript. Queue no
   read RPC and execute no command until connectivity/trust are current.

## Cutover invariants

- There is no negotiated downgrade for the conversation data plane. Removed
  Gateway state/history RPC event kinds are ignored rather than interpreted as
  native timeline events.
- Existing Gateway delivery WAL entries retain stable transaction IDs.
- Existing sessions receive one idempotent `session_root` during startup and
  persist its Matrix event ID before their ports emit threaded output.
- All supported APK and PWA builds restore state and history from version-2
  timeline envelopes. Pre-release clients that only understand the removed RPC
  flow must be replaced and paired again.
