# Security threat model

## Required guarantee

A malicious or compromised Matrix homeserver may observe metadata, delay,
delete, reorder or replay ciphertext, but it must not be able to read Codever
content or cause a local AgentProvider operation.

Codever content is encrypted and signed at the application layer before it is
passed to the Matrix SDK. Matrix Megolm remains defense in depth; neither the
homeserver nor the Matrix protocol is a Codever trust root.

## Trusted components

- the installed Codever PWA or desktop application;
- the local Gateway binary and its operating-system account;
- the locally enrolled Codever device keys;
- the Codever application and its bundled dependency execution environment;
- configured ACP providers while they execute locally.

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
5. the pairing certificate is active and permits the operation;
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

Local event journals and provider session state are therefore authoritative for
execution recovery. Matrix is authoritative only for delivery of ciphertext
that passes local validation.

## Release tests

- Captured homeserver traffic contains no prompt, cwd, filename or tool output.
- Matrix SDK send APIs receive a fixed placeholder body plus opaque ciphertext.
- An unencrypted event causes zero provider calls.
- An unknown, unverified or key-substituted device causes zero provider calls.
- Changing any signed field invalidates the command.
- Wrong-Gateway and wrong-conversation commands are rejected.
- Expired commands are rejected.
- Replaying one ciphertext or command ID executes at most once across restart.
- Reordering device-to-Gateway commands produces a sequence gap and zero
  execution for the out-of-order command.
- Concurrent commands from different devices carry a Gateway conversation
  revision. Only a command based on the current revision is accepted; a stale
  writer receives an application-encrypted conflict. The PWA shows the
  conflicting action and requires the user to review it before creating a new
  command ID and signature against the current revision.
- The PWA advances its durable outbox only after a Gateway-signed secure
  acknowledgement, never from a Matrix transaction acknowledgement.
- A valid Gateway-signed final result also completes the matching durable
  reservation atomically. This covers result-before-ack and permanently
  missing-ack delivery without permitting a sequence to be reused.
- A forged Gateway response is rejected by the PWA.
- Every Gateway reply is independently encrypted for each active application
  device. Revoking one device removes only that recipient from future fan-out.
- Collaboration prompts, command results and per-device edit targets use a
  durable local recipient outbox. Missing copies retain stable Matrix
  transaction IDs and are retried without duplicating successful recipients.

## Current product boundary

- Protocol v1 supports multiple paired application devices in one room. Each
  device has its own P-256 identity, certificate, command sequence and Matrix
  transaction stream. The Gateway never shares an application group key.
- Matrix can observe fan-out traffic metadata, including the number and timing
  of opaque events. It cannot identify their plaintext, forge a recipient
  envelope, or silently reorder accepted cross-device mutations because the
  Gateway conversation revision is checked locally.
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
- If a queued command exceeds its signed validity window before the Gateway
  acknowledges it, the PWA fails closed and asks the user to re-pair. A new
  certificate generation starts a fresh ordered-command epoch.
- Matrix sync tokens are persisted per homeserver, user, Matrix device and
  room. They are availability state, not trust state: an observed device-list
  change is accepted only when the persistent Gateway application key signs
  the exact replacement transport identity.
- The PWA holds an exclusive Web Lock for the full lifetime of each Matrix
  crypto database. A second tab, or a browser without Web Locks, fails closed
  instead of sharing Rust crypto state.
- An IndexedDB degradation, unexpected close or failed forced checkpoint
  permanently disables mutations for that connection. Later sync callbacks
  cannot restore an online state; the device must be rebuilt and re-paired.
- The first upgrade from a build without a persisted sync token cannot
  reconstruct device-list changes already omitted by an initial sync. If the
  signed Gateway Matrix device is absent from the local crypto store, the PWA
  fails closed and requires a new Matrix device plus application re-pairing.
