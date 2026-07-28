# Local Matrix test server

This environment runs the official Synapse image for local integration tests.
It is deliberately bound to `localhost`, uses test-only credentials and is not
a production server.

From a PowerShell terminal at the repository root:

```powershell
.\scripts\matrix-local.ps1 bootstrap
```

The command starts Synapse, creates separate `tester` and `gateway` accounts,
creates a private encrypted room, joins both accounts and writes the local
credentials to `dev/matrix/local-test.json`. That file and Synapse's data
directory are ignored by Git.

Useful commands:

```powershell
.\scripts\matrix-local.ps1 status
.\scripts\matrix-local.ps1 stop
```

Run the automated legacy Matrix transport check with:

```powershell
npm run test:matrix-live
```

This creates fresh Matrix devices, checks Megolm transport, signed commands,
replay protection and a deterministic provider reply. It explicitly uses the
legacy test-only path; use the manual PWA flow below to exercise pairing and
the independent application-encryption envelope.

Run the actual Gateway pairing experience with:

```powershell
npm run dev:matrix-gateway
```

On first launch the Gateway displays a terminal QR code, a six-digit invitation
code, and a pasteable fallback link. In the PWA, choose **Real Matrix**, scan or
paste the invitation, enter only `tester.accessToken` from
`dev/matrix/local-test.json`, and confirm once. The Gateway persists its
application identity and trusted PWA device under `dev/matrix/gateway-data`,
separate from Synapse's own `dev/matrix/data`, then starts the agent immediately.

On later launches no new pairing is required. The local Node Matrix crypto
device is intentionally ephemeral; the Gateway signs the replacement Matrix
device with its persistent P-256 application key and the PWA updates the pin
automatically.

Because the local homeserver uses HTTP, test it with the locally served PWA on
`http://localhost`, not the HTTPS-hosted preview. Browsers block an HTTPS page
from connecting to an HTTP homeserver.

For the manual PWA-to-agent walkthrough, see
[`docs/real-matrix-testing.md`](../../docs/real-matrix-testing.md).
