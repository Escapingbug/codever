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

Run the fully automated real-protocol check with:

```powershell
npm run test:matrix-live
```

This creates fresh Matrix devices, exchanges Megolm-encrypted events through
the local Synapse process, verifies the independent P-256 command signature in
the real Gateway, executes a deterministic test provider and decrypts its reply.

Because the local homeserver uses HTTP, test it with the locally served PWA on
`http://localhost`, not the HTTPS-hosted preview. Browsers block an HTTPS page
from connecting to an HTTP homeserver.

For the manual PWA-to-agent walkthrough, see
[`docs/real-matrix-testing.md`](../../docs/real-matrix-testing.md).
