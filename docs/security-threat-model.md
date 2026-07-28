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
- The PWA advances its durable outbox only after a Gateway-signed secure
  acknowledgement, never from a Matrix transaction acknowledgement.
- A forged Gateway response is rejected by the PWA.

## Current product boundary

- Protocol v1 intentionally allows one paired application device per room.
  The local Gateway refuses to open a second enrollment flow while one active
  device exists; multi-recipient reply fan-out is a later protocol version.
- The local Gateway checks the trusted-device registry for every command, so a
  CLI revocation blocks new Agent operations without relying on Matrix state.
- If a queued command exceeds its signed validity window before the Gateway
  acknowledges it, the PWA fails closed and asks the user to re-pair. A new
  certificate generation starts a fresh ordered-command epoch.
