# Matrix-native conversation protocol

Status: protocol version 2, pre-release hard cutover

Codever uses Matrix as a durable conversation system, not as an RPC queue. The
homeserver remains untrusted for business plaintext and execution authority.
There is no checkpoint, state-request, history-request, or version-1
compatibility path in the native data plane.

## Native object mapping

| Codever concept | Matrix concept | Authority |
| --- | --- | --- |
| Gateway workspace and capabilities | `io.codever.gateway.current.v2` Room State | one state key per Gateway |
| Current/archived/deleted session | `io.codever.session.current.v2` Room State | one state key per session; delete is a tombstone |
| Session identity | `m.thread` root | immutable `session_root` event ID |
| User/agent/tool output | thread reply | Matrix event ID plus signed logical ID |
| Session/revision audit | room or thread timeline event | append-only history |
| Older conversation history | Matrix relations/backward pagination | the homeserver timeline |

One configured encrypted room may currently contain several project
identities. Each session state and root carries its signed project ID, name,
and path. A future Space topology may split projects into rooms without
changing the state or thread semantics.

## Current state and independent convergence

The Gateway publishes a replace-in-place session state entity for every live
or archived session and retains a deleted tombstone for every removed session.
Gateway state independently contains:

- the revision epoch and current conversation revision;
- a monotonically increasing `state_version`;
- workspace defaults, capabilities, and active-device count.

Gateway and session state keys converge independently, exactly like other
Matrix room-state entities. A new or replaced session becomes visible when its
authenticated entity arrives; it never waits for an application-level global
snapshot, count, digest, or checkpoint. Events from a retired revision epoch
are ignored, and each state key is monotonic within the current epoch. State
replacement uses a durable latest-write-wins outbox; a crash or rate limit
retries the same stable Matrix state tuple.

Timeline events cannot create, resurrect, archive, or delete sessions. They
provide immutable roots, visible conversation output, audit history, command
completion evidence, and low-latency revision progress. Commands without a
session mutation emit `gateway_revision`; the corresponding revision is also
replaced in Gateway Room State, so an offline client does not need timeline
replay to become current.

## Client recovery

Connected clients follow this algorithm:

1. Start Matrix sync and authenticate the pinned Gateway application key and
   current Matrix transport binding. For a new device, the Gateway first
   publishes immutable thread roots and complete current Room State addressed
   to that device, and only then sends the signed pairing response. That
   response is the commit marker. Before its first send, the client encrypts
   the exact signed request in durable local storage. Before exposing success,
   it also verifies and durably encrypts the response beside that request.
   Android's service resumes that same transaction across WebView detach and
   process death without another scan, identity, native confirmation, or
   approval. The response is a durable proof with the same lifetime as its certificate; the Gateway
   redelivers it only while that exact certificate remains active, so
   revocation cannot be bypassed by replaying an interrupted request.
2. Fetch current Room State directly, independent of any persisted `/sync`
   cursor. The Gateway state is processed first to obtain the addressed key
   ring, followed by per-session entities.
3. Validate envelope bindings and signatures. One complete `/state` read is
   committed atomically to the local projection. Gateway metadata makes the
   connection writable; later per-session replacement events converge
   independently within that authenticated Gateway epoch.
4. Use incremental `/sync` state updates for live replacement events. On a
   reconnect, foreground return, or limited sync, fetch current Room State
   again; do not scan timeline history to reconstruct the directory.
5. Load a selected session's transcript from local encrypted storage and its
   Matrix thread relations. Paginate older relations only when the user asks.
6. Offline, show the last verified local projection and transcript as a cache,
   but execute no command until current Room State has been authenticated.

Android establishes its dedicated live `/sync` cursor with timeline limit zero;
it does not turn initial sync into a room-history fetch. Each later batch is
cryptographically validated and durably applied before the `/sync` token is
saved, so a process exit causes safe Matrix redelivery instead of a lost local
transition. The native SDK Timeline is a short-lived trust-bootstrap channel
only: it opens for the explicit Megolm pairing request/response and closes when
that exchange settles. It is not part of the connected conversation data path.

A local browser/APK cache is never connected-state authority. A cached
projection cannot make the UI report Connected and cannot release an outbound
command by itself.

Gateway workspace, project, capability, and session fields use one strict
version-2 schema on Gateway, browser, and APK. Missing fields, duplicate
capability IDs, unknown fields, or type mismatches reject the complete Room
State refresh instead of producing different projections on different clients.

## Application encryption

Matrix E2EE protects transport, while Codever application encryption prevents
a malicious or compromised homeserver from reading Codever content.

Each room has a durable AES-256-GCM key ring. Timeline and Room State envelopes
are Gateway-signed and bind Gateway, conversation, room, epoch, and their
logical Matrix location. A state envelope additionally binds event type,
state key, and state version. Moving ciphertext between rooms or state keys
fails authentication.

The Gateway state event carries the pairwise encrypted key-ring bundle
addressed to active Codever devices. Per-session Room State reuses that epoch
key and does not repeat the device bundle. This keeps state replacement small
and makes device count affect bytes in one Gateway state event rather than every
session entity. Timeline events that must be independently readable retain
their own addressed key-ring bundle.

Adding a device grants retained epochs. Removing or revoking a device rotates
the active epoch. Removed devices retain plaintext they legitimately saw
before revocation but cannot decrypt later epochs. Matrix event content is
bounded below the homeserver event limit; exhausting the retained epoch budget
is an explicit room-migration condition, never silent history loss.

Commands, acknowledgements, results, conflicts, and invitation control remain
pairwise signed/encrypted because they are device-specific and executable.
The certificate carries the complete current command grant set; neither the
Gateway nor a native client adds local compatibility permissions. Command
authorization requires that certificate, Matrix transport binding, sequence
epoch, and replay-ledger validation. Conversation revision is a
compare-and-swap precondition for state-dependent mutations; stale append-only
prompts can be linearized when intervening revisions are also prompts.

The connected data plane has no Megolm fallback. Timeline envelopes are sent
as direct standard `m.room.message` events, while commands and their targeted
responses use `io.codever.secure_control.v1`. A client rejects the same
application envelope if it arrives through an old encrypted-room-message
route. Megolm remains limited to the explicit pre-trust pairing exchange and
Gateway transport rotation.

## Delivery and rate budget

Steady-state traffic follows visible business semantics:

- one user command and its targeted acknowledgement/result;
- one collaboration/thread event for the user prompt;
- agent messages or edits that are actually visible;
- one session Room State replacement plus one small Gateway metadata update when the
  durable session summary changes;
- no Gateway state/history RPC on connect, focus, scrollback, or reconnect;
- no full-timeline backfill merely because a key or current state changed.

Status replacement is latest-write-wins and bounded independently from the
command authorization lane. Both delivery outboxes honor homeserver retry
timing, so raising Matrix rate limits is not a correctness requirement.

## Cutover invariants

- Removed `gateway_checkpoint`, `gateway_state_request`, and `history_request`
  kinds are neither emitted nor parsed.
- Every supported PWA and APK build uses current Room State for the session
  directory and Matrix relations for history.
- Existing pre-release clients must be replaced; there is no negotiated
  downgrade.
- Missing application timeline, control, or Room State transport support is a
  hard error; the Gateway never silently falls back to an older data path.
- Existing sessions receive one idempotent `session_root`, whose Matrix event
  ID is persisted before threaded output is published.
- Archive and delete never redact Matrix history; deletion removes the session
  from the current projection through an authenticated state tombstone.
