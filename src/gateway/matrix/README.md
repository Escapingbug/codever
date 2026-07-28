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
