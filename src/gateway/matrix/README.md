# Matrix gateway integration contract

## Paired device keys

Each `trustedDevices` record binds two independent identities:

- `publicKey` is the Codever P-256 public JWK exported by the PWA. The gateway
  uses it to verify the ES256 signature over every `signed_command`. Matrix
  membership and power levels never replace this signature.
- `matrixDeviceKeys` contains the raw Matrix Ed25519 fingerprint strings
  returned by `MatrixEvent.getClaimedEd25519Key()` after successful E2EE
  decryption. These values are not Matrix device IDs and are not Curve25519
  sender keys. The PWA pairing export must label them accordingly.
- `matrixDeviceId` locates the paired device in the Matrix device list. Before
  sending any agent output, the gateway checks that device's Ed25519
  fingerprint against `matrixDeviceKeys`, marks only that device verified and
  enables the SDK's verified-device-only room-key policy. Incoming events are
  decrypted so their application signature and locally pinned Matrix
  fingerprint can be checked, while unverified devices never receive outgoing
  room keys.

The gateway requires both the Codever signature and the locally pinned Matrix
sender/user plus Ed25519 fingerprint to match.

## Gateway event delivery shape

One logical Gateway broadcast is one Matrix room event, regardless of the
number of paired application devices. Its `io.codever` extension has kind
`secure_envelope_bundle`: the message ciphertext is shared, while every
recipient has a separately ECDH-derived wrapped content key. The durable
Matrix outbox persists one bundle record with a snapshot of all recipient
certificate epochs and application key IDs. Restart recovery therefore retries
one stable Matrix transaction and abandons the bundle if any staged recipient
identity has rotated or been revoked.

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
signed version-2 timeline envelopes restored with Matrix sync, threads, and
backward pagination. The pre-release state/history RPC event kinds are not
accepted or emitted.

## Command event shape

Commands are encrypted `m.room.message` events. Their decrypted content uses a
normal text fallback plus the Codever extension:

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

Unsigned text, a different extension kind, clear-text events, unknown Matrix
device keys, invalid signatures, expired commands, and replayed command IDs or
nonces cannot reach `TopicSession`.

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
