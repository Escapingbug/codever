# Real Matrix testing

The rewrite has two real test paths. The automated path is a legacy Matrix
transport smoke test. The manual path exercises pairing, the application
envelope, secure command acknowledgement, key rotation and a real configured
Codever provider.

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

## Automated legacy transport smoke test

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
3. Signed command validation, replay checks and provider execution.
4. A reply delivered through the real Matrix room.

This script explicitly enables `allowInsecureLegacyForTesting`; it does **not**
prove the PWA pairing certificate or ECDH/HKDF/AES-GCM application envelope.
Use the manual path below for that security boundary.

## Manual PWA-to-agent test

Start the local PWA in one terminal:

```powershell
cd apps\pwa
npm run dev
```

Open the localhost URL printed by the development server. Switch the app from
**Demo** to **Real Matrix**.

Start the real local Gateway from the repository root in another terminal:

```powershell
npm run dev:matrix-gateway
```

On first launch the Gateway displays a terminal QR code, invitation code, and
pasteable fallback link. Scan the QR code in the PWA or paste the link. The PWA
shows the Gateway name and the same invitation code; no Matrix fingerprints or
JSON files are exposed.

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
  local-test flag. The fresh device is signed by the persistent Gateway P-256
  application key, so the PWA updates its Matrix pin automatically without
  another user pairing action.
- An already paired PWA follows that signed rotation. A pairing request that
  has not yet received its first certificate cannot survive this local
  Gateway's fresh Matrix-device restart; rescan the new QR. Production desktop
  packaging must persist the Gateway Matrix crypto device.
- The Gateway application identity, trusted devices, one-time offer replay
  ledger and current rotation head are persisted independently of Matrix.
  The local fixture stores them in ignored `dev/matrix/gateway-data`.
- The hosted PWA requires an HTTPS Matrix homeserver. Browsers will block its
  connection to this HTTP localhost fixture as mixed content.
