# @codever/security

The default package entry is browser-safe and uses WebCrypto only:

```ts
import {
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  signCommand,
  verifyCommand,
} from '@codever/security'
```

Node-only durable stores are intentionally isolated:

```ts
import {
  FileIdempotencyStore,
  FileReplayStore,
} from '@codever/security/node'

const replay = new FileReplayStore('/var/lib/codever/replay.json')
const ledger = new FileIdempotencyStore('/var/lib/codever/ledger.json')
```

Each store serializes a full read/modify/write transaction with an atomic
`mkdir` lock, so multiple gateway processes using the same local filesystem
cannot both win a claim. The state file uses `.next` and `.previous` recovery
files around replacement.

Lock directories are never automatically declared stale. If a process exits
without releasing `<state-path>.lock`, first verify that no gateway process is
using the state file, then remove that exact lock directory manually. This
avoids a wall-clock timeout incorrectly breaking a live process's lock.

The gateway should process an incoming command in this order:

1. Verify the application signature and local gateway/device/conversation
   bindings.
2. Look up or claim the command in the idempotency ledger. Return a completed
   result without executing it again.
3. For a new execution claim, claim the nonce and command ID with the replay
   guard.
4. Execute once, then persist the completed or failed ledger result.

Matrix sender IDs, room membership, power levels, and homeserver responses are
transport data only and must not replace application signature verification.

Gateway-to-device broadcasts use `secure-envelope-bundle` rather than one
room event per application device. The Gateway encrypts the JSON payload once
with a random AES-256-GCM content key, wraps that key independently for each
recipient with P-256 ECDH/HKDF/AES-GCM, and signs the complete bundle. Opening
a bundle still requires the locally paired device ID, application key ID,
Gateway signing key, conversation binding, validity window, and replay claims.
The single-recipient envelope is the current device-to-Gateway command and
targeted Gateway-to-device control format.
