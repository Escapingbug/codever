# Security threat model

## Required guarantee

A malicious or compromised Matrix homeserver may observe metadata, delay,
delete, reorder or replay ciphertext, but it must not be able to read Codever
content or cause a local AgentProvider operation.

Codever content is encrypted and signed at the application layer before it is
passed to the Matrix SDK. Matrix Megolm remains defense in depth for flows that
use it; executable control events deliberately bypass Megolm so Gateway device
rotation cannot block them. Neither the homeserver nor the Matrix protocol is a
Codever trust root.

## Trusted components

- the installed Codever PWA or desktop application;
- the local Gateway binary and its operating-system account;
- the locally enrolled Codever device keys;
- the Codever application and its bundled dependency execution environment;
- configured ACP providers while they execute locally.
- when remote privileged execution is installed: the root-owned Helper bundle,
  service definition and policy, plus the local Gateway account that holds its
  client credential.

The PWA hosting origin is part of the trusted computing base. A production
release must not load executable JavaScript from the Matrix homeserver. The
Matrix SDK API receives only opaque Codever envelopes, but a compromised
dependency executing arbitrary code in the same JavaScript realm remains a
software-supply-chain compromise; process/Worker isolation is a separate
hardening boundary.

## Untrusted inputs

- all Matrix homeserver responses and room state;
- room membership, power levels, display names and aliases;
- event IDs, server timestamps and transaction acknowledgements;
- events from unknown or newly created Matrix devices;
- repeated, reordered, edited or redacted events;
- provider output rendered in the client.
- privileged-execution proposals, including executable paths, arguments,
  reasons and working directories, until both device approval and Helper
  policy validation succeed.

## Privileged execution boundary

Remote root execution is disabled unless the host owner installs a separate
root Helper. The administrator password never enters Codever, Matrix, the
Agent, or the PWA. The Gateway stores only an owner-readable random client
credential; the root configuration stores its SHA-256 digest.

A privilege decision may be answered only by an active device certificate that
contains the separately granted `privilege.approve` operation. Normal pairing
does not grant it. The decision event is carried by the same signed,
application-encrypted CVP/3 path as other decisions.

The Helper authenticates the local Gateway account through its owner-only Unix
socket credential, but that credential alone cannot execute a command. Every
request also carries a six-digit TOTP generated after WebAuthn-protected device
unlock. The shared TOTP key exists only in the root Helper configuration and as
WebAuthn-PRF-encrypted PWA storage. The Helper rate-limits invalid codes and
durably accepts each matched TOTP time step only once.

The Helper then requires a short-lived, previously unused request, resolves
the executable's real path, applies its root-owned allowlist or explicit broad
policy, rejects group/world-writable executables, spawns without an implicit
shell, supplies a minimal environment, closes stdin, caps output, and kills
timed-out process groups.

TOTP is intentionally a simplified boundary. The live code passes through the
Gateway and is not bound to the exact command. Compromise of the Gateway does
not reveal the long-term TOTP key, but an attacker may observe and race a code
during its accepted time step. Transaction-bound approval signatures are a
future hardening option, not a guarantee of this version. There is no
multi-command or ten-minute privilege lease.
macOS TCC and similar consent databases are outside this mechanism and are not
bypassed.

## Gateway acceptance rule

Before a request reaches `SemanticSessionRuntime`, the Gateway must verify:

1. the event contains a valid Codever secure envelope;
2. its ES256 signature and AES-GCM authentication validate against the paired
   application keys;
3. the envelope binds the Gateway, conversation, direction, both devices,
   both keys, expiry and unique replay identifiers;
4. strict mode requests contain a valid Codever command signature that binds
   the protocol version, Gateway, conversation, operation,
   payload hash, command ID, issuance time, expiry and nonce;
5. the pairing certificate is active and explicitly permits the operation;
6. neither the envelope nor command replay claim has been consumed;
7. the command sequence is exactly the next value for the current pairing
   certificate generation;
8. a duplicate of an already accepted command receives another encrypted
   acknowledgement but never executes the mutation twice.

Every rejection occurs before an AgentProvider is created or invoked.

## Explicit non-goals

Codever cannot prevent a malicious homeserver from:

- denying service or permanently deleting ciphertext;
- observing account, room, membership, IP, timing and size metadata;
- withholding a legitimate command or response;
- presenting stale room state.

The Gateway's durable command/result ledger and provider session state are
authoritative for execution recovery. Authenticated Matrix Room State is the
client authority for the current Gateway/session directory, while signed
thread events are the transcript authority. Unauthenticated or stale Matrix
content grants neither execution nor trust.

## Release tests

- Captured homeserver traffic contains no prompt, cwd, filename or tool output.
- Matrix SDK send APIs receive a fixed placeholder body plus opaque ciphertext.
- An event without a valid Codever application envelope causes zero provider
  calls, whether or not the outer Matrix event uses Megolm.
- An unknown, unverified or key-substituted device causes zero provider calls.
- Changing any signed field invalidates the command.
- Wrong-Gateway and wrong-conversation commands are rejected.
- Expired commands are rejected.
- Replaying one ciphertext or command ID executes at most once across restart.
- Reordering device-to-Gateway commands produces a sequence gap and zero
  execution for the out-of-order command.
- Concurrent commands from different devices carry a Gateway conversation
  revision. When all missing revisions are prompts, the Gateway assigns a stale
  append-only prompt the next revision in arrival order; its device sequence,
  command ID and durable fingerprint still enforce exactly-once execution. A
  prompt crossing a state mutation, or a stale state-dependent mutation,
  receives an application-encrypted conflict, and the PWA requires review
  before creating a new command ID and signature against the current revision.
- The PWA advances its durable outbox only after a Gateway-signed secure
  acknowledgement, never from a Matrix transaction acknowledgement.
- A valid Gateway-signed final result also completes the matching durable
  reservation atomically. This covers result-before-ack and permanently
  missing-ack delivery without permitting a sequence to be reused.
- A forged Gateway response is rejected by the PWA.
- A confirmed pairing request is encrypted and persisted before transport
  delivery. The verified response is encrypted and persisted before local
  success is exposed. Recovery retransmits the same signed request, while the
  Gateway redelivers its durable response only if the exact certificate is
  still active. A revoked device therefore cannot replay an interrupted
  pairing to restore local trust.
- Every Gateway reply is independently encrypted for each active application
  device. Revoking one device removes only that recipient from future fan-out.
- Collaboration prompts, command results and per-device edit targets use a
  durable local recipient outbox. Missing copies retain stable Matrix
  transaction IDs and are retried without duplicating successful recipients.
- A normal paired device cannot resolve a privilege decision. A
  `privilege.approve` device can select only an advertised decision value.
- Helper requests with a wrong credential, missing/invalid/replayed TOTP,
  expired grant, duplicate request ID, unsafe or policy-excluded executable,
  oversized output, or elapsed timeout fail closed. Argument metacharacters
  remain argv bytes and do not implicitly invoke a shell.

## Current product boundary

- The pairing/control protocol supports multiple paired application devices in one room. Each
  device has its own P-256 identity, certificate, command sequence and Matrix
  transaction stream. The Gateway never shares an application group key.
- Matrix can observe fan-out traffic metadata, including the number and timing
  of opaque events. It cannot identify their plaintext, forge a recipient
  envelope, or silently reorder accepted commands: the Gateway durably assigns
  their conversation revisions, while state-dependent mutations additionally
  require the current base revision.
- Physical Matrix event IDs differ by recipient. The Gateway persists the
  per-recipient mapping used by later edits. A device added after the original
  message has no historical target, so its first edit is safely delivered as a
  standalone message.
- Pending recipient copies are bound to the original application certificate
  and public-key generation. Revocation or re-pairing the same device ID cannot
  transfer old queued plaintext to a new key.
- The durable recipient outbox contains plaintext on the trusted Gateway disk
  until its recipient copies are delivered. Protect it with the same operating
  system account and storage controls as the Gateway identity and session data.
- The local Gateway checks the trusted-device registry for every command, so a
  CLI revocation blocks new Agent operations without relying on Matrix state.
- If an authenticated queued command exceeds its signed validity window before
  the Gateway accepts it, the Gateway atomically consumes only that device's
  exact next sequence as a terminal failure and never executes the payload.
  The authenticated result releases the PWA outbox, so later commands continue
  without re-pairing. Gaps, reused identities, invalid signatures and commands
  from an inactive certificate still fail closed.
- Matrix sync tokens are persisted per homeserver, user, Matrix device and
  room. They are availability state, not trust state: an observed device-list
  change is accepted only when the persistent Gateway application key signs
  the exact replacement transport identity.
- The PWA holds an exclusive Web Lock for the full lifetime of each Matrix
  crypto database. A second tab, or a browser without Web Locks, fails closed
  instead of sharing Rust crypto state.
- An IndexedDB degradation, unexpected close or failed local sync-store flush
  permanently disables mutations for that connection. Later sync callbacks
  cannot restore an online state; the device must be rebuilt and re-paired.
- A browser whose persisted sync token or crypto database is evicted cannot
  infer omitted device-list changes from application state. If the signed
  Gateway Matrix device is absent from the rebuilt crypto store, the PWA fails
  closed and requires a new Matrix device plus application re-pairing.
