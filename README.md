# Codever

Codever is a native remote client for ACP-compatible coding agents. A Gateway
runs on each controlled computer and keeps project paths, provider processes,
credentials and execution state local. Standard Matrix provides account
identity, encrypted multi-device delivery, durable synchronization and history.

```text
Codever Android / desktop client
               |
       Matrix Olm/Megolm E2EE
               |
        unmodified Synapse
               |
       Matrix Olm/Megolm E2EE
               |
      Codever Gateway(s) -> local ACP providers
```

Matrix device verification is necessary but not sufficient to run commands.
Every Gateway mutation also carries a short-lived COSE Sign1/CWT authorization
for the exact request. The Gateway verifies it against local execution roots,
then applies persistent replay protection and an idempotent request ledger.

This branch is a flag-day replacement for the former Telegram and custom
Relay/NATS/OPAQUE runtime. It intentionally contains no transport compatibility
layer.

## Requirements

- Node.js 20 or newer and pnpm 11
- Rust 1.93 or newer for the Matrix transport and native client
- Android SDK/NDK for Android builds
- A local ACP-compatible provider such as Codex or OpenCode

## Install and verify

```powershell
pnpm install --frozen-lockfile
pnpm typecheck:all
pnpm test:all
pnpm test:business-e2e
pnpm build:all
cargo test --manifest-path crates/matrix-transport/Cargo.toml
cargo check --manifest-path apps/web/src-tauri/Cargo.toml
```

## Deploy Matrix

The stock private Synapse deployment is in [`deploy/matrix`](deploy/matrix).
Public registration and federation are disabled. The homeserver is not trusted
with plaintext or execution authorization; it stores encrypted events and can
observe only Matrix metadata.

```sh
cd deploy/matrix
sudo ./bootstrap.sh
docker compose -f compose.server.yml up -d
```

See [`docs/matrix-transport.md`](docs/matrix-transport.md) for the trust model,
initial account setup, Matrix SAS device verification and first execution-root
approval.

## Configure a Gateway

Build the native Matrix sidecar and Gateway, then initialize one persistent
Matrix device. Gateway initialization is machine-scoped and does not require a
project path.

```powershell
cargo build --release --manifest-path crates/matrix-transport/Cargo.toml
pnpm build
Get-Content .\matrix-password.txt | node dist/index.js init `
  --homeserver https://matrix.example.com `
  --username codever `
  --password-stdin `
  --matrix-transport .\crates\matrix-transport\target\release\codever-matrix-transport.exe `
  --name workstation
```

Verify the Gateway Matrix device with the client while the Gateway service is
stopped:

```powershell
node dist/index.js verify
```

Approve the first client execution public key locally, then start the Gateway:

```powershell
node dist/index.js control trust --owner <client-device> --key <public-jwk.json>
node dist/index.js start
node dist/index.js project add --path D:\projects\codever --name codever
```

Later clients use Matrix SAS plus approval by an existing authorized client;
they do not require shell access to the Synapse server or Gateway.

## Shared native client

The Vue UI and Tauri shell are shared by Windows, Android and iOS.

```powershell
pnpm --filter @codever/web dev
pnpm --filter @codever/web desktop:build
pnpm --filter @codever/web android:build
```

Client state and recent conversations are cached locally. Matrix sync updates
them in the background, so cached sessions remain readable during reconnects.
Provider output is rendered as Markdown; raw ACP lifecycle events are projected
into concise status, tool and decision UI rather than transcript noise.
Attachments use standard Matrix encrypted media with disk-streaming encryption
and download; Codever does not impose a total file-size limit or buffer the
entire file in memory.

## Security boundary

- Synapse sees account/room/device/timing/size metadata but not E2EE payloads.
- Commands from unencrypted or unverified Matrix devices are discarded.
- A verified Matrix event still cannot execute without a valid Gateway-pinned
  COSE/CWT signature for its exact operation and payload.
- Expiry, clock-skew bounds, replay storage and request idempotency fail closed.
- Provider credentials and unrestricted filesystem access never leave Gateway.

The deterministic business coverage is tracked in
[`docs/business-capability-matrix.md`](docs/business-capability-matrix.md).

The approved next-stage product/UI architecture is documented in
[`docs/product-design-next.md`](docs/product-design-next.md). For moving the
repository to another machine or rebuilding an agent session, use
[`docs/migration-handoff-2026-07-21.md`](docs/migration-handoff-2026-07-21.md)
as the handoff checklist and context summary.
