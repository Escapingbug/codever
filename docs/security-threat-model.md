# Security threat model

## Required guarantee

A malicious or compromised Matrix homeserver may observe metadata, delay,
delete, reorder or replay ciphertext, but it must not be able to read Codever
content or cause a local AgentProvider operation.

## Trusted components

- the installed Codever PWA or desktop application;
- the local Gateway binary and its operating-system account;
- the locally enrolled Codever device keys;
- the Matrix client cryptography implementation shipped with Codever;
- configured ACP providers while they execute locally.

The PWA hosting origin is part of the trusted computing base. A production
release must not load executable JavaScript from the Matrix homeserver.

## Untrusted inputs

- all Matrix homeserver responses and room state;
- room membership, power levels, display names and aliases;
- event IDs, server timestamps and transaction acknowledgements;
- events from unknown or newly created Matrix devices;
- repeated, reordered, edited or redacted events;
- provider output rendered in the client.

## Gateway acceptance rule

Before a request reaches `SemanticSessionRuntime`, the Gateway must verify:

1. the event was encrypted and successfully decrypted;
2. the sending Matrix device matches a locally enrolled device fingerprint;
3. strict mode requests contain a valid Codever signature;
4. the signature binds the protocol version, Gateway, conversation, operation,
   payload hash, command ID, issuance time, expiry and nonce;
5. the device has the capability required by the operation;
6. the token or event fingerprint has not been consumed;
7. the command ledger has not already executed the mutation.

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
- An unencrypted event causes zero provider calls.
- An unknown, unverified or key-substituted device causes zero provider calls.
- Changing any signed field invalidates the command.
- Wrong-Gateway and wrong-conversation commands are rejected.
- Expired commands are rejected.
- Replaying one ciphertext or command ID executes at most once across restart.
- Reordering conversation events produces a detectable sequence gap.
- A forged Gateway response is rejected by the PWA.

