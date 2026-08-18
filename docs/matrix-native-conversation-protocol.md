# Matrix-native conversation protocol

Status: protocol version 2, pre-release hard cutover

Codever uses Matrix as a durable conversation system, not as an RPC queue. The
homeserver remains untrusted for business plaintext and execution authority.
There is no checkpoint, state-request, history-request, or version-1
compatibility path in the native data plane.

## Native object mapping

| Codever concept | Matrix concept | Authority |
| --- | --- | --- |
| Gateway workspace, capabilities, and directory commit | `io.codever.gateway.current.v2` Room State | one state key per Gateway |
| Bounded current session directory | `io.codever.session.directory.v2` Room State | directly addressed immutable pages in three rotating slots |
| Live session entity and delete audit | `io.codever.session.current.v2` Room State | one state key per session; delete is a tombstone |
| Session identity | `m.thread` root | immutable `session_root` event ID |
| User/agent/tool output | thread reply | Matrix event ID plus signed logical ID |
| Session/revision audit | room or thread timeline event | append-only history |
| Older conversation history | Matrix relations/backward pagination | the homeserver timeline |

One configured encrypted room may currently contain several project
identities. Each session state and root carries its signed project ID, name,
and path. A future Space topology may split projects into rooms without
changing the state or thread semantics.

## Current state and bounded convergence

The Gateway publishes a replace-in-place session entity for low-latency live
updates and retains a deleted tombstone for audit. Cold-start inventory does
not enumerate all Room State and does not replay every historical session
tombstone. Instead, the Gateway publishes the complete current/archived
directory as bounded, directly addressable pages. Gateway state contains:

- the revision epoch and current conversation revision;
- a monotonically increasing `state_version`;
- a directory descriptor containing generation, rotating slot, page count,
  state-key prefix, and canonical digest;
- workspace defaults, capabilities, and active-device count.

Each page contains at most 32 sessions and at most 20 KiB of plaintext. The
Gateway writes every page for a new generation first, writes changed individual
session entities second, and replaces Gateway state last. That last event is
the commit marker that makes the page generation discoverable. Clients fetch
the exact Gateway state key, fetch the exact page keys named by its descriptor,
and fetch Gateway state again. They commit the directory only when both
descriptors match and every page binding, index, count, and digest validates.
Three rotating slots prevent an older reader from accepting pages overwritten
by a newer generation.

This is a bounded Matrix-state snapshot, not an application RPC checkpoint:
the client can address every object through standard Room State GETs, and no
request event is sent to the Gateway. Live session state keys still converge
independently between directory commits. Events from a retired revision epoch
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
2. Fetch the exact Gateway Room State key directly, independent of any
   persisted `/sync` cursor. Use its directory descriptor to fetch only the
   exact bounded page keys; never issue a room-wide `/state` request.
3. Fetch Gateway state again, validate the stable descriptor plus every
   envelope binding, page index/count, unique session ID, and canonical digest,
   then atomically replace the local directory projection. Gateway metadata
   makes the connection writable; later per-session replacement events
   converge independently within that authenticated Gateway epoch.
4. Use incremental `/sync` state updates for live replacement events. On a
   reconnect or foreground return, re-run the exact-key directory read; do not
   scan timeline history to reconstruct the directory. When `/sync` marks a
   timeline as `limited`, persist `(old_since, prev_batch, cursor)` before
   advancing the live token. Recover that gap with standard forward
   `/messages?from=<cursor>&to=<prev_batch>` pages, commit every page cursor,
   deduplicate by authenticated event identity, and remove the gap only after
   the boundary closes. Live sync continues while the durable gap journal
   drains, and process death resumes the same journal.
5. Load a selected session's transcript from local encrypted storage and its
   Matrix thread relations. Paginate older relations only when the user asks.
6. Offline, show the last verified local projection and transcript as a cache,
   but execute no command until current Room State has been authenticated.

Android establishes its dedicated live `/sync` cursor with a bounded timeline
limit; it does not turn initial sync into an unbounded room-history fetch. Each
later batch is cryptographically validated and durably applied before the
`/sync` token is saved. A limited batch first persists its missing interval, so
a process exit causes safe `/sync` or `/messages` redelivery instead of a lost
transition. The native SDK Timeline is a short-lived trust-bootstrap channel
only: it opens for the explicit Megolm pairing request/response and closes when
that exchange settles. It is not part of the connected conversation data path.

Conversation output is also physically bounded. UTF-8 bodies larger than 8 KiB
are emitted as deterministic ordered continuation events with one logical
message ID and part metadata. Progressive edits defer oversized intermediate
values; the terminal edit replaces the first part and emits each continuation
once. A client that was offline or killed restores the same parts from the
session thread rather than depending on one oversized Matrix response.

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
- one session Room State replacement for a live entity update; when the durable
  directory changes, bounded directory pages are written before one small
  Gateway commit update;
- no Gateway state/history RPC on connect, focus, scrollback, or reconnect;
- no full-timeline backfill merely because a key or current state changed.

Status replacement is latest-write-wins and bounded independently from the
command authorization lane. Both delivery outboxes honor homeserver retry
timing, so raising Matrix rate limits is not a correctness requirement.

## Cutover invariants

- Removed `gateway_checkpoint`, `gateway_state_request`, and `history_request`
  kinds are neither emitted nor parsed.
- Every supported PWA and APK build uses exact-key Gateway/directory Room State
  reads for the current session inventory and Matrix relations for history.
- Existing pre-release clients must be replaced; there is no negotiated
  downgrade.
- Missing application timeline, control, or Room State transport support is a
  hard error; the Gateway never silently falls back to an older data path.
- Existing sessions receive one idempotent `session_root`, whose Matrix event
  ID is persisted before threaded output is published.
- Archive and delete never redact Matrix history; deletion removes the session
  from the committed directory while retaining an authenticated state
  tombstone for audit and live convergence.
