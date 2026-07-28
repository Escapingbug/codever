# Real Matrix testing

The rewrite now has two real test paths. The automated path proves the complete
wire protocol without depending on an installed agent CLI. The manual path
uses the PWA and a real configured Codever provider.

## Prerequisites

- Docker Desktop is running.
- Node.js 22 or newer is installed.
- Root and PWA dependencies have been installed with `npm ci`.
- For the manual agent test, the selected provider CLI is installed and signed
  in. The local Gateway defaults to the built-in `codex` provider.

The local environment uses the official Synapse container, binds it only to
`localhost:8008` and stores disposable data under the ignored
`dev/matrix/data` directory. Its deliberately relaxed login rate limit is not
safe for a public server.

## Automated real-protocol smoke test

From the repository root:

```powershell
.\scripts\matrix-local.ps1 bootstrap
npm run test:matrix-live
```

A passing run ends with:

```text
[5/5] PASS — decrypted Gateway reply received ...
```

That run exercises:

1. Separate PWA and Gateway Matrix accounts and fresh devices.
2. Matrix Rust crypto and an encrypted Megolm room.
3. A separate P-256 Codever device identity and signed command.
4. Gateway room, sender, Ed25519 fingerprint, expiry and replay checks.
5. Provider execution and an encrypted reply decrypted by the tester.
6. Verified-device-only room-key sharing in both directions.

## Manual PWA-to-agent test

Start the local PWA in one terminal:

```powershell
cd apps\pwa
npm run dev
```

Open the localhost URL printed by the development server. Switch the app from
**Demo** to **Real Matrix**, open Matrix settings, and copy the following
values from the ignored `dev/matrix/local-test.json` file:

| PWA field | Local test value |
| --- | --- |
| Homeserver | `homeserver` |
| Matrix user | `tester.userId` |
| Access token | `tester.accessToken` |
| Device ID | `tester.deviceId` |
| Encrypted room | `roomId` |
| Gateway ID | `gatewayId` |
| Conversation ID | `roomId` |

Leave the three **Gateway Matrix** identity fields empty on the first
connection. Click **Connect securely**. This first connection creates the local
P-256 identity, starts persistent browser Matrix crypto and makes **Copy pairing
record** available. Save that copied JSON as the ignored file
`dev/matrix/pairing.json`.

Start the real local Gateway from the repository root in a second terminal:

```powershell
npm run dev:matrix-gateway
```

The Gateway creates a fresh Matrix device, starts the configured `codex`
provider and prints three exact values:

- `gatewayMatrixUserId`
- `gatewayMatrixDeviceId`
- `gatewayMatrixEd25519`

Paste those into the matching PWA fields and click **Reconnect**. The PWA checks
the device fingerprint locally, marks only that device verified and refuses to
send until the pin is complete. The Gateway performs the same check against the
PWA pairing record before it can send agent output.

Send a prompt in the chat. It should appear in the Gateway terminal's provider
session, and the encrypted response should appear in the PWA.

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

- Browser crypto is persisted in IndexedDB.
- The localhost Gateway intentionally uses an in-memory Matrix crypto store and
  a fresh Matrix device on every start. This is allowed only by the explicit
  local-test flag.
- A packaged desktop Gateway still needs a durable native crypto-store design.
- The hosted PWA requires an HTTPS Matrix homeserver. Browsers will block its
  connection to this HTTP localhost fixture as mixed content.
