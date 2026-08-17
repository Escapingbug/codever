# Matrix gateway integration contract

## Paired device keys

Each `trustedDevices` record binds two independent identities:

- `publicKey` is the Codever P-256 public JWK exported by the PWA. The gateway
  uses it to verify the ES256 signature over every `signed_command`. Matrix
  membership and power levels never replace this signature.
- `matrixDeviceKeys` contains the raw Matrix Ed25519 fingerprint used by the
  explicit Megolm pairing and transport-rotation channel. These values are not
  Matrix device IDs and are not Curve25519 sender keys.
- `matrixDeviceId` locates the paired device in the Matrix device list. The
  Gateway verifies that transport before the pairing exchange. Connected
  commands, Room State, and timeline output then rely on the separately pinned
  Codever application identity and do not depend on Megolm room-key delivery.

The gateway requires both the Codever signature and the locally pinned Matrix
sender/user plus Ed25519 fingerprint to match.

## Gateway event delivery shape

One logical Gateway broadcast is one version-2 Matrix timeline envelope,
regardless of the number of paired application devices. The message ciphertext
uses the room's retained application key epoch; the accompanying key-ring grant
wraps those epoch keys separately for every recipient. The durable Matrix
outbox persists one logical broadcast with the addressed certificate and key
generations. Restart recovery retries one stable Matrix transaction and never
transfers a queued grant to a rotated or revoked identity.

Application messages carry a stable `logical_event_id`; edits additionally
carry `replaces_logical_event_id`. These IDs, not recipient-specific Matrix
event IDs, join live delivery to late-join history and are the PWA's message and
replacement identities. Matrix event IDs remain transport receipts only.

Targeted acknowledgements, command results, and revision conflicts remain
single-recipient envelopes. Their outer Matrix event type is
`io.codever.secure_control.v1`: the homeserver can see only envelope routing
metadata and ciphertext, while the persistent Gateway application key signs
the envelope and the recipient's application key encrypts its contents. This
keeps the control path independent from delayed or missing Megolm room keys.
Session state and conversation history are not control responses: they are
signed version-2 timeline envelopes stored as standard `m.room.message`
events and restored with Matrix sync, threads, and backward pagination. The
inner envelope already provides end-to-end confidentiality and authentication,
so these events are sent directly instead of being wrapped in a second Megolm
layer. This lets a newly paired device read shared history using the timeline
key grant and lets native clients consume the same durable room events through
a filtered `/sync`, without an RPC state/history protocol. The pre-release
state/history RPC event kinds are not accepted or emitted.
There is also no Megolm compatibility fallback for connected timeline or
control traffic: a transport without the direct application event APIs fails
closed.

## Command event shape

Commands use direct `io.codever.secure_control.v1` room events. Their Matrix
content is an opaque `secure_envelope`; after application-layer decryption the
inner content uses a normal text fallback plus the Codever extension:

```json
{
  "msgtype": "m.text",
  "body": "Codever command",
  "io.codever": {
    "version": 1,
    "kind": "signed_command",
    "signed_command": {
      "command": {},
      "signature": {}
    }
  }
}
```

Unsigned text, a different extension kind, invalid application envelopes,
unknown or revoked application devices, invalid signatures, expired command
payloads, and replayed command IDs or nonces cannot reach `TopicSession`. An
expired command that is exactly the authenticated device's next sequence is
atomically journaled as a terminal failure, so it cannot execute or block later
commands. Because the outer control event deliberately bypasses Megolm, a
Gateway Matrix device rotation cannot strand a valid command behind a missing
room key.

Recovery preserves the authenticated command identity but creates a fresh
Matrix transaction and outer secure envelope for each transport attempt. The
Gateway can therefore open the retry, match it against the durable command
ledger, and re-deliver the original result without executing the command a
second time. The durable fingerprint includes the complete authenticated
command; a changed retry is rejected instead of entering a migration path.

Authenticated Gateway Room State also carries the durable accepted command
sequence for every active application device and certificate epoch. A client
reconciles that cursor before enabling command submission. This lets an APK
upgrade quarantine an old locally ambiguous command without guessing whether
the Gateway accepted it: the next command fills an unaccepted sequence or
continues after an accepted one, while the quarantined command is never sent
again.

## Crypto initialization

Production configuration must set `crypto.useIndexedDB` to `true` and provide a
stable `databasePrefix`. A 32-byte `storageKey` or a `storagePassword` should
protect that persistent crypto store. In-memory crypto is rejected unless
`allowInMemoryForTesting` is explicitly enabled.

## Local administration

The Gateway host may expose the local administration API over a Unix domain
socket (or a current-user-only named pipe on Windows). It must never expose
these routes on a TCP listener.

The active Matrix process owns the server so device invitations are bound to
its current Matrix transport fingerprint:

```text
codever gateway invite
  -> admin.sock
  -> DeviceInvitationCoordinator
  -> GatewayPairingService
```

The local admin and authenticated-PWA `device.invite` paths share the same
coordinator, invitation limit, persistence, and signing identity. A configured
Matrix login-token issuer may exchange the PWA account's long-lived access
token for a short-lived one-time login token. The access token is never returned
from the admin API, written to logs, or placed in a QR code.

A paired-device invitation is idempotent for the full retained lifetime of its
source command, including after the offer expires. Recovering an old command
returns that original expired result; only a new command ID may authorize a new
offer.

Current routes:

- `GET /v1/status`
- `GET /v1/devices`
- `POST /v1/device-invitations`
- `DELETE /v1/device-invitations/:offerId`
- `POST /v1/devices/:deviceId/revoke`

Mutation requests are local-user authorized by socket permissions. Invitation
creation additionally requires an `Idempotency-Key`, is rate limited, and
returns responses with `Cache-Control: no-store`.

The local Matrix host recognizes:

- `CODEVER_GATEWAY_ADMIN_SOCKET` to override the socket path;
- `CODEVER_PWA_LOGIN_FILE` to locate owner-only PWA Matrix credentials used
  solely for `get_login_token`;
- `CODEVER_PWA_URL` as the CLI default invitation destination.

For example:

```sh
codever gateway invite \
  --app-url https://pwa.example/ \
  --matrix-login preferred \
  --qr png \
  --output codever-invitation.png
```
