# Matrix transport and execution authorization

Matrix owns account identity, encrypted device-to-device delivery, durable sync,
timeline history, retry and device verification. Matrix does not authorize
Gateway execution. Every `io.codever.command.v1` event carries an
`AuthorizedClientGatewayRequestFrame`; the Gateway verifies its COSE Sign1/CWT
against a Gateway-local control-root key before an ACP operation can run.

## Trust boundaries

- Matrix Olm/Megolm encryption prevents the homeserver from reading command,
  response and conversation payloads.
- Matrix SAS verifies that a client is the intended physical device. Gateway
  commands from unencrypted or unverified Matrix devices are discarded.
- COSE/CWT independently proves that the exact operation and request were
  signed by an execution root trusted locally by that Gateway.
- Short expiry, request hashes, a persistent replay guard and an idempotent
  request ledger prevent a captured event from executing twice.
- A compromised homeserver can observe metadata and delay, drop or replay
  ciphertext. It cannot forge a verified device or a valid execution signature.

## First installation

1. Initialize and start the private Synapse deployment. Public registration and
   federation remain disabled.
2. Initialize the Gateway with `codever init`. This creates a persistent Matrix
   device and encrypted crypto store; no project path is required.
3. Log the native client into the same Matrix account.
4. Stop the Gateway service. In the client Settings screen, request verification
   for the Gateway Matrix device shown by `codever verify`.
5. Run `codever verify -c <gateway-config>`. Compare the emoji on both devices
   and confirm only when their order is identical. The verification command and
   the Gateway service must not open the same Matrix store concurrently.
6. Create the first client execution identity and approve its public JWK locally
   with `codever control trust --owner <client-id> --key <public-jwk>`.
7. Restart `codever start`. The client can now discover and control the Gateway.

The local trust command is needed only for the first execution root. A later
client first completes Matrix SAS with an existing device, then publishes an
approval request. An already authorized client signs `execution.root.trust`;
the Gateway accepts that mutation only because it is itself a valid authorized
COSE request. Reinstallation therefore does not require logging into the
homeserver host.

## Room model

- One private encrypted Space represents a Codever workspace.
- Each Gateway has an opaque encrypted control room for presence, inventory,
  project creation and authorization administration.
- Each Project has an opaque encrypted room. Project names and paths are
  encrypted timeline payloads, not public Matrix state.
- A Session is rooted by an `io.codever.session.v1` event. Conversation and
  command events use an `m.thread` relation to that root.

The initial implementation uses the encrypted control room while project-room
provisioning is completed. Event transaction IDs are Codever request/event IDs,
so Matrix retries converge on one event.

## Event types

| Type | Direction | Purpose |
| --- | --- | --- |
| `io.codever.command.v1` | Client to Gateway | COSE-authorized ACP/business command |
| `io.codever.response.v1` | Gateway to Client | Accepted or terminal command response |
| `io.codever.conversation.v1` | Gateway to Client | Normalized semantic conversation event |
| `io.codever.inventory.v1` | Gateway to Client | Gateway/project/session inventory snapshot |
| `io.codever.gateway.v1` | Gateway to Client | Gateway identity, platform and presence |
| `io.codever.discovery.v1` | Client to Gateway | Encrypted discovery request |
| `io.codever.authorization.v1` | Client to Client | Verified execution-root approval request |
| `io.codever.session.v1` | Gateway to Client | Session root for Matrix threads |

Only decrypted events from verified Matrix devices cross the native trust
boundary. Gateway command handling still requires valid COSE authorization.

## Attachments

Attachment commands currently stream 24 KiB plaintext chunks. The small frame
size leaves room for JSON, COSE and Megolm/base64 overhead under Matrix event
limits; it does not impose a total file-size limit. The Gateway encrypts each
stored blob independently and keeps resumable manifests and cleanup state.

For high-throughput large files, the next storage backend is standard Matrix
encrypted media (`EncryptedFile`) with an authorized encrypted manifest event.
Until that backend is active, large files are correct and resumable but create
many timeline events and are not expected to provide media-upload throughput.
