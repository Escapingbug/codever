# Codever Relay

The Relay accepts outbound Gateway WebSocket connections and serves the Web client API. Normal client access uses local Relay accounts and opaque bearer sessions.

## Start

From the repository root:

```powershell
pnpm --filter @codever/relay start
```

For a production bundle:

```powershell
pnpm --filter @codever/relay build
pnpm --filter @codever/relay start:built
```

Set `CODEVER_RELAY_CONFIG` to a JSON file based on `relay.config.example.json`. Relative TLS and legacy enrollment paths are resolved from the config file directory.

Relay state is durable by default. `dataDirectory` defaults to `./data` relative to the config file (or the current working directory when no config file is supplied). The Relay atomically persists Gateway/Project/Session metadata and command state, and stores session events in a checksummed append-only log. On restart it restores all repositories and their idempotency indexes. A torn final event-log write is truncated; corruption in any complete record or JSON snapshot stops startup instead of silently discarding data.

Supported environment overrides:

- `CODEVER_RELAY_HOST`, `CODEVER_RELAY_PORT`, `CODEVER_RELAY_ID`, `CODEVER_RELAY_LOGGER`
- `CODEVER_RELAY_TLS_CERT_FILE`, `CODEVER_RELAY_TLS_KEY_FILE`
- `CODEVER_RELAY_ENROLLMENT_FILE`
- `CODEVER_RELAY_USERS_FILE`
- `CODEVER_RELAY_DATA_DIRECTORY`, `CODEVER_RELAY_REPOSITORY_MODE`
- `CODEVER_RELAY_GATEWAYS_JSON` containing an enrollment array or `{ "gateways": [...] }`
- `CODEVER_RELAY_USERS_JSON` containing a user array or `{ "users": [...] }`
- `CODEVER_RELAY_SESSION_TTL_SECONDS` (minimum 60; defaults to 30 days)
- `CODEVER_RELAY_DEV_WORKSPACE_ID`

TLS certificate and key must be supplied together. They are the Relay HTTPS server credentials, not a Gateway identity.

`CODEVER_RELAY_REPOSITORY_MODE` accepts `durable` (the default) or `memory`. Memory mode is intentionally explicit and is only suitable for tests or disposable local development; all Relay inventory, commands, and events are lost at process exit.
The executable prints a warning whenever memory mode is enabled. Programmatic server tests may also inject the in-memory repositories directly.

The durable repository stores dynamic Gateway public keys and pending requests in `gateway-enrollments.json`; it never stores Gateway private keys or Relay TLS credentials. It rejects PEM private-key material. Back up the data directory using filesystem snapshots or while the Relay is stopped; do not edit its files manually.

## Gateway dynamic pairing

Every Gateway creates and reuses a local P-256 identity. On `codever start` it proves possession of that private key to the Relay and prints an eight-character pairing code, fingerprint, and expiry. The private key never leaves the Gateway.

The first Gateway must be approved on the Relay host while the Relay process is running:

```powershell
pnpm --filter @codever/relay enrollment list
pnpm --filter @codever/relay enrollment approve ABC23456
```

The command connects to a local-only Unix socket or Windows named pipe and authenticates with a random secret stored mode `0600` in the Relay data directory. It never edits the enrollment database concurrently and there is no public bootstrap approval endpoint. `list`, `approve CODE`, and `reject CODE [reason]` are supported.

The first local approval atomically persists `bootstrapComplete=true`. Removing or revoking every Gateway does not reopen bootstrap. Deliberate recovery requires this exact local confirmation:

```powershell
pnpm --filter @codever/relay enrollment reset-bootstrap RESET-GATEWAY-BOOTSTRAP
```

After bootstrap, authenticated `admin` and `gateway_admin` accounts can inspect and approve/reject matching-workspace requests. Approval requires the UI to echo the exact fingerprint, name, and platform shown to the user. `viewer` and `operator` accounts cannot manage enrollment, and a Gateway WebSocket identity is never accepted as client authorization.

Pending codes expire after ten minutes, are single-use, omit ambiguous characters, and enrollment challenge/proof attempts are rate-limited. A waiting Gateway retries enrollment and authentication automatically; after approval it connects and performs normal inventory/event synchronization.

### Enrollment REST API

- `POST /v1/gateway-enrollments/challenge` — public proof-of-possession challenge; accepts `GatewayEnrollmentChallengeRequest`.
- `POST /v1/gateway-enrollments/proof` — public signed proof; returns `GatewayEnrollmentDto` with pending code or approved status.
- `GET /v1/gateway-enrollments` — admin list (`GatewayEnrollmentListDto`).
- `GET /v1/gateway-enrollments/:code` — admin pending detail (`GatewayEnrollmentDto`).
- `POST /v1/gateway-enrollments/:code/approve` — admin approval with `ApproveGatewayEnrollmentDto`.
- `POST /v1/gateway-enrollments/:code/reject` — admin rejection with `RejectGatewayEnrollmentDto`.
- `GET /v1/enrolled-gateways` — admin dynamic key list (`EnrolledGatewayKeyListDto`).
- `POST /v1/enrolled-gateways/:gatewayId/revoke` — admin revocation (`EnrolledGatewayKeyDto`).

All DTO schemas and parse functions are exported by `@codever/protocol` from `enrollment.ts`.

## Legacy static enrollment

Static config remains supported for migration and disaster recovery. On startup those public keys are imported idempotently into the dynamic store; an enabled trusted static key marks bootstrap complete. Copy `enrollment.example.json` to a private deployment configuration location and replace the example entry. Only these fields are accepted:

- `gatewayId`
- `fingerprint`
- `publicKeySpkiPem`
- `enabled`

The Relay verifies that each key is an EC P-256 public key and that its SHA-256 fingerprint matches. Unknown fields and all private-key fields are rejected. A Gateway identity private key must remain on the Gateway machine and must never be copied to the Relay.

## Client accounts and sessions

Set `usersFile` to a JSON file based on `users.example.json`, or set `users` directly in the Relay config. Every user accepts only these fields:

- optional `id` (otherwise derived from workspace and username)
- `username`
- `passwordHash`
- `workspaceId`
- non-empty `roles`: `viewer`, `operator`, `gateway_admin`, or `admin`
- `enabled`

Plaintext password fields and unknown fields are rejected. Generate a fresh scrypt hash by piping a password on stdin; password arguments are intentionally unsupported:

```powershell
$secret = Read-Host -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) | pnpm --filter @codever/relay password:hash
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
```

The auth API is:

- `POST /v1/auth/login` with username, password, and optional device name
- `GET /v1/auth/session` with a bearer token
- `POST /v1/auth/logout` with a bearer token

Bearer tokens are random opaque values. Only SHA-256 token hashes, account IDs, optional device names, and lifecycle timestamps are stored in `dataDirectory/auth-sessions.json`; logout revokes the matching record and expired records are rejected. User enablement is checked on every request.

REST requests use `Authorization: Bearer <token>`. Browser event WebSockets offer both `codever.events.v1` and `codever.bearer.<token>` in `Sec-WebSocket-Protocol`; the Relay reads the bearer protocol but negotiates only the fixed `codever.events.v1` protocol. The token is never placed in the URL.

`viewer` is read-only. `operator` can also create/configure/cancel/message sessions and answer decisions. `gateway_admin` can additionally manage dynamic Gateway enrollment and revocation, while `admin` allows every client action. `viewer` and `operator` cannot approve, reject, or revoke Gateways. All target Gateway resources are checked against the account workspace.

## Insecure development authentication

Local development can explicitly disable account authentication:

```powershell
$env:CODEVER_RELAY_INSECURE_DEV_AUTH='true'
$env:CODEVER_RELAY_DEV_WORKSPACE_ID='development'
pnpm --filter @codever/relay start
```

Any value other than the exact string `true` leaves deny-all authentication enabled. Never set this flag on an Internet-accessible Relay.
