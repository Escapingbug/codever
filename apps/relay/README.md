# Codever Relay

Relay is a secure-only ACP Gateway transport. It terminates independent OPAQUE channels for Gateways and Clients, then encrypts every application frame with `SessionCipher`. HTTPS is optional at the deployment edge and is not required by Relay's security model.

Relay stores Gateway metadata and long-term OPAQUE credential records. It has no user accounts, passwords, bearer tokens, HTTP login, or legacy authentication compatibility. Client-to-Gateway `opaquePayload` values are routed unchanged; Relay never decrypts that inner secure channel.

## Start

```powershell
pnpm --filter @codever/relay start
```

Configure it with `CODEVER_RELAY_CONFIG` and `relay.config.example.json`. Supported environment overrides are:

- `CODEVER_RELAY_HOST`, `CODEVER_RELAY_PORT`, `CODEVER_RELAY_ID`, `CODEVER_RELAY_LOGGER`
- `CODEVER_RELAY_DATA_DIRECTORY`, `CODEVER_RELAY_REPOSITORY_MODE`

`repositoryMode` is `durable` by default. Durable mode stores `gateways.json`, `secure-gateway-credentials.json`, `secure-client-credentials.json`, and local-control material. Gateway and Client credential files contain separate OPAQUE server setups.

## Pairing

Create one-time OPAQUE pairing tickets through the authenticated local control socket:

```powershell
pnpm --filter @codever/relay pair:gateway
pnpm --filter @codever/relay pair:client
```

Pairing provisions a long-term credential. Subsequent connections use that credential and do not reuse the pairing code.

## Public surface

- `GET /health`
- `GET /v2/gateway/connect` (OPAQUE + encrypted WebSocket)
- `GET /v2/client/connect` (OPAQUE + encrypted WebSocket)

There are no `/v1/auth/*`, `/v1/gateways`, or `/v2/device/connect/:gatewayId` routes. Gateway discovery and all device tunnel open/data/close routing frames travel inside the encrypted Client↔Relay session.

After Gateway authentication and optional credential provisioning, Gateway application input is restricted to `gateway.hello`, `gateway.heartbeat`, `device.tunnel.data`, and `device.tunnel.close`. Inventory, event, command-result, and other business frames are rejected.
