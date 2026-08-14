# Real Matrix testing

The rewrite has one automated Alpha path plus an optional manual development
path. Both exercise pairing, application encryption, secure command
acknowledgement, Room State, thread history, and a configured provider. There
is no insecure legacy transport test mode.

## Prerequisites

- Docker Desktop is running.
- Node.js 22 or newer is installed.
- Workspace dependencies have been installed with `pnpm install`.
- For the manual agent test, the selected provider CLI is installed and signed
  in. The local Gateway defaults to the built-in `codex` provider.

The local environment uses the official Synapse container, binds it only to
`localhost:8008` and stores disposable data under the ignored
`dev/matrix/data` directory. Its deliberately relaxed login rate limit is not
safe for a public server.

## Automated Alpha acceptance

From the repository root:

```powershell
$env:CODEVER_ALPHA_LIVE_E2E = '1'
$env:CODEVER_ANDROID_SERIAL = 'emulator-5554'
pnpm test:e2e:alpha-live
```

A passing run ends with:

```text
[8/8] PASS — real browser, Synapse, Gateway, E2EE, history, and deletion converged.
```

That run exercises:

1. Separate browser, APK, and Gateway Matrix devices.
2. Pairing certificates and application-layer encrypted control events.
3. Current Room State, per-session threads, history, and offline cache recovery.
4. Exactly-once command recovery, concurrent mutations, notifications, and
   browser/APK convergence.
5. A browser deletion submitted while Gateway `/sync` is stalled beyond the
   watchdog boundary, including in-place sync restart, active Agent
   preservation, and exactly-once recovery.

## Manual PWA-to-agent test

Start the local PWA in one terminal:

```powershell
cd apps\pwa
npm run dev
```

Open the localhost URL printed by the development server. Codever opens
directly in the real secure workspace; there is no demo-mode switch. On a new
browser device the **Add a Gateway** dialog opens automatically.

Start the real local Gateway from the repository root in another terminal:

```powershell
npm run dev:matrix-gateway
```

On first launch the Gateway displays a terminal QR code, invitation code, and
pasteable fallback link. In the browser, use the automatically opened
**Add a Gateway** dialog to scan the QR code or paste the link. The PWA shows
the Gateway name and the same invitation code; no Matrix fingerprints or JSON
files are exposed.

For this disposable local fixture only, expand **Matrix connection** and copy
one value from `dev/matrix/local-test.json`:

| PWA field | Local test value |
| --- | --- |
| Access token | `tester.accessToken` |

The PWA asks the QR-provided homeserver who the token belongs to and fills the
Matrix account and device automatically. Changing the invitation to a
different homeserver clears the saved token before any request is made.

The QR invitation supplies the homeserver, encrypted room and complete signed
Gateway route. Confirm **Trust Codever local Gateway and pair** once. The PWA
pins the offered Matrix device, sends an encrypted hidden-challenge-bound
request, verifies the signed response and certificate, and stores the
persistent Gateway application key. The Gateway stores the trusted PWA device
and starts the configured provider without a restart.

Send a prompt in the chat. It should appear in the Gateway terminal's provider
session, and the encrypted response should appear in the PWA.

### Add a second collaborating device

Keep the first PWA paired. Restart the local Gateway with an explicit local
enrollment window:

```powershell
$env:CODEVER_PAIR_NEW_DEVICE = '1'
npm run dev:matrix-gateway
```

The persistent Gateway identity signs its new Matrix transport device and
prints an **Add another Codever device** QR/link. Open the PWA in another
browser profile, device, or origin so it receives an independent application
key, then pair with a fresh Matrix device access token.

Both PWAs should show two active devices. A prompt from either PWA appears in
the other with its originating device name and Gateway revision. Agent replies,
streaming edits and permission requests are independently encrypted to both
devices. Concurrent prompts are accepted in Gateway order even if one device
is briefly behind. A stale state-dependent mutation produces a visible review
card and is discarded or re-signed only after the user reviews the latest
state and confirms it.

Use the pairing CLI `list` and `revoke --device DEVICE_ID` commands from
[pairing-gateway.md](pairing-gateway.md) to revoke one device. The remaining
PWA continues receiving replies; the revoked device receives no future
application-layer copies and cannot execute new commands.

To select another built-in or configured provider:

```powershell
$env:CODEVER_PROVIDER = 'opencode'
$env:CODEVER_CWD = 'C:\path\to\your\project'
npm run dev:matrix-gateway
```

Stop the Gateway and PWA with Ctrl+C. Stop Synapse when finished:

```powershell
.\scripts\matrix-local.ps1 stop
```

## Current test boundary

- Browser crypto and the Matrix `/sync` token are persisted in
  device-scoped IndexedDB databases. The PWA flushes the local store after initial
  sync and on explicit disconnect so a later reconnect can consume device-list
  changes that happened while it was offline.
- Keep only one Codever tab open for a given Matrix device. The PWA enforces
  this with a full-lifetime Web Lock and rejects a second tab before either
  instance can share the Rust crypto database.
- If a previously signed Gateway Matrix device is not visible to the Matrix
  crypto store, the PWA fails closed instead of trusting room state. This can
  occur after browser storage eviction; sign in as a new Matrix device and pair it again.
- The localhost Gateway intentionally uses an in-memory Matrix crypto store and
  a fresh Matrix device on every start. This is allowed only by the explicit
  local-test flag. The fresh device is signed by the persistent Gateway P-256
  application key. The live encrypted rotation is the fast path; a root-signed
  current-transport snapshot in the Gateway's extended Matrix profile lets an
  offline PWA catch up without another user pairing action or room state power.
- The local Gateway's application delivery outbox is durable. Restart and
  short Matrix outages should recover only missing recipient copies, using
  their original stable transactions and certificate generation.
- An already paired PWA follows that signed rotation. A pairing request that
  has not yet received its first certificate cannot survive this local
  Gateway's fresh Matrix-device restart; rescan the new QR. Paired-device
  recovery requires a homeserver with the Matrix `m.profile_fields` capability.
- The Gateway application identity, trusted devices, one-time offer replay
  ledger and current rotation head are persisted independently of Matrix.
  The local fixture stores them in ignored `dev/matrix/gateway-data`.
- Per-recipient live-edit event mappings are currently process-local. After a
  restart, an edit for an older message is delivered as a new independently
  encrypted message rather than referencing another device's Matrix event ID.
- The hosted PWA requires an HTTPS Matrix homeserver. Browsers will block its
  connection to this HTTP localhost fixture as mixed content.
