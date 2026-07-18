# Codever Relay

Relay is the one-time pairing and credential-issuing edge for Codever. Daily commands, events, inventories, presence, and encrypted files use NATS JetStream directly; Relay does not proxy application traffic or keep application session state.

## Security model

- A three-minute OPAQUE pairing request authorizes one locally generated NKey public key.
- Relay signs a narrowly scoped NATS user JWT with `nsc`; the private NKey seed never leaves the Client or Gateway.
- Client-to-Gateway command, response, event, inventory, and file payloads remain end-to-end encrypted.
- JetStream provides durable delivery, acknowledgements, redelivery, ordering metadata, and consumer cursors.

## Start

```powershell
pnpm --filter @codever/relay start
```

Configure with `CODEVER_RELAY_CONFIG` and `relay.config.example.json`. Environment overrides are:

- `CODEVER_RELAY_HOST`, `CODEVER_RELAY_PORT`, `CODEVER_RELAY_ID`, `CODEVER_RELAY_LOGGER`
- `CODEVER_RELAY_DATA_DIRECTORY`
- `CODEVER_RELAY_NATS_URL`, `CODEVER_RELAY_NATS_GATEWAY_URL`, `CODEVER_RELAY_NATS_WEBSOCKET_URL`, `CODEVER_RELAY_NATS_CREDENTIALS_FILE`
- `CODEVER_RELAY_NSC_EXECUTABLE`, `CODEVER_RELAY_NSC_CONFIG_DIRECTORY`, `CODEVER_RELAY_NSC_STORE_DIRECTORY`, `CODEVER_RELAY_NSC_KEYS_DIRECTORY`
- `CODEVER_RELAY_NSC_OPERATOR`, `CODEVER_RELAY_NSC_ACCOUNT`

The nsc store and keys directories must contain the operator and account signing material used by the running NATS server.

## Pairing

Generate one-time pairing tickets through the local control interface:

```powershell
pnpm --filter @codever/relay pair:gateway
pnpm --filter @codever/relay pair:client
```

After pairing, the WebSocket closes and the issued NKey/JWT credential is used directly with NATS. Gateway device pairing also runs over a short-lived JetStream subject and provisions the Client-to-Gateway HPKE identity.

## Public surface

- `GET /health`
- `GET /v2/gateway/connect` — one-time OPAQUE provisioning
- `GET /v2/client/connect` — one-time OPAQUE provisioning

There are no application tunnel, Blob, Gateway metadata, or session-routing HTTP endpoints.
