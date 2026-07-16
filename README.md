# Codever multi-Gateway platform

This branch is a flag-day implementation of Codever as a remote ACP agent platform. It is isolated from the running Telegram branch and does not use Telegram as its runtime, session identity, transcript, or UI.

```text
Web / PWA / Tauri client
          |
      HTTPS + WSS
          |
     Codever Relay
          |
 outbound signed WSS
          |
 Codever Gateway(s)
          |
    local ACP agents
```

The Gateway remains the trusted execution boundary on each controlled machine. It owns approved project roots, provider credentials/processes, decisions, and the authoritative event journal. One Relay accepts multiple independently enrolled Gateways and exposes Gateway → Project → Session navigation to a single Vue client shared by browsers, installed PWAs, desktop, Android, and iOS shells.

## Implemented

- Browser-safe, versioned protocol schemas for inventory, events, commands, authentication, sync, and client DTOs.
- Per-Gateway P-256 static identity stored locally as a PKCS#8 private key; enrollment exports only the SPKI public key and fingerprint.
- TLS server validation plus signed Relay challenges bound to the Relay challenge, Gateway ID, and key fingerprint.
- Explicit local project allowlists with canonical path and traversal/symlink escape checks.
- Gateway-owned session runtime, decision broker, provider normalization, durable metadata, and append-only event journal.
- Outbound reconnecting Gateway link with epochs, heartbeats, command idempotency, event ACKs, and cursor replay.
- Multi-Gateway Relay REST/WSS APIs, enrollment, deny-by-default authorization, event subscriptions, and restart sync.
- Vue 3 structured timeline for assistant output, tools, decisions, status, session controls, and offline state.
- One UI distributed as Web, installable PWA, and a minimal Tauri 2 desktop/mobile shell.
- Real in-process E2E tests covering signed enrollment, session creation, provider execution, REST/WSS history, and Relay backfill from a Gateway journal.

See [the architecture](docs/multi-gateway-client-design.md), [Relay operations](apps/relay/README.md), and [client packaging](apps/web/README.md).

## Requirements

- Node.js 20 or newer
- pnpm 11
- At least one supported local provider command (`opencode`, `codebuddy`, Cursor `agent`, Codex ACP, or a configured ACP command)
- Rust and platform WebView tools only when building Tauri packages

## Install and verify

```powershell
pnpm install --frozen-lockfile
pnpm typecheck:all
pnpm test:all
pnpm test:e2e
pnpm build:all
pnpm audit --prod
```

## Configure a Gateway

The Relay URL is always entered explicitly. Use `wss://` outside localhost; unencrypted `ws://` is accepted only for loopback development.

```powershell
pnpm build
node dist/index.js init `
  --relay wss://relay.example.com/v1/gateway/connect `
  --root D:\projects `
  --name workstation
```

Register project roots locally. Remote clients select a `projectId`; they cannot submit arbitrary working directories.

```powershell
node dist/index.js project add --path D:\projects\codever --name codever
node dist/index.js project list
```

Export the public enrollment bundle. This command never prints the private key.

```powershell
node dist/index.js enrollment > gateway-enrollment.json
```

Copy the public `gatewayId`, fingerprint, and `publicKeySpkiPem` into the Relay enrollment file, then start the Gateway:

```powershell
node dist/index.js start
```

Gateway configuration and identity default to `~/.config/codever/`. The private key must remain on the Gateway machine. Back it up as a sensitive machine credential; enrollment is secure only while that key and the Relay TLS endpoint remain trusted.

## Run Relay

Copy the examples in `apps/relay/`, configure HTTPS certificate/key and public Gateway enrollments, then:

```powershell
$env:CODEVER_RELAY_CONFIG = 'D:\codever-relay\relay.json'
pnpm --filter @codever/relay start
```

Relay client APIs deny access by default. `CODEVER_RELAY_INSECURE_DEV_AUTH=true` grants every client request and is only for a loopback/private development environment. Do not expose that mode to a network. A production deployment still needs an OIDC/passkey/session authenticator appropriate to the operator environment.

## Run the shared client

```powershell
pnpm --filter @codever/web dev
pnpm --filter @codever/web build
pnpm --filter @codever/web desktop:dev
```

The recommended Web deployment reverse-proxies Relay under the same HTTPS origin. PWA API responses are never cached. Android requires Android SDK/NDK; iOS builds require macOS, Xcode, and signing credentials. Those native toolchains are not vendored.

## Security boundary

- Relay stores public Gateway keys only; unknown, disabled, stale-epoch, or incorrectly signed Gateways are rejected.
- Standard TLS protects links and provides ephemeral transport keys. The static Gateway key authenticates the machine; it is not used as a bulk-encryption key.
- Relay is trusted with plaintext event content in this version. This is not end-to-end encryption against Relay.
- Provider credentials and unrestricted filesystem access stay on Gateway.
- Gateway persists before publishing; Relay transports commands at least once and uses idempotency keys to prevent duplicate effects.
- Permission decisions are Gateway-authoritative and expire fail-closed.

## Current release limits

- Production client authentication is an integration point, not a bundled identity provider.
- Attachments, remote project creation, key rotation UI, audit UI, notifications, and store signing are not yet implemented.
- Tauri configuration is shared across desktop/mobile, but Android/iOS packages must be built and tested on their required platform toolchains.
- Legacy Telegram source remains in the repository during the rewrite, but it is not part of the new build entrypoint and is not a compatibility requirement for this branch.
