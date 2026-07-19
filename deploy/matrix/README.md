# Private Matrix transport

This is a private, non-federating Matrix homeserver. Synapse supplies identity,
Olm/Megolm encryption, durable sync, timeline history and media storage. It is
not trusted to authorize Gateway execution: each command additionally carries
a short-lived COSE/CWT token signed by a Gateway-pinned Codever control root.

```sh
chmod +x bootstrap.sh
sudo ./bootstrap.sh
docker compose -f compose.server.yml up -d
```

Place `Caddyfile.fragment` inside the existing HTTPS site block before its
fallback handler, validate, then reload Caddy. Only Matrix client routes are
proxied; federation routes are not exposed.

For the current Codever server layout this can be applied idempotently with:

```sh
chmod +x install-caddy-route.sh
sudo ./install-caddy-route.sh
```

Create initial accounts from the server only:

```sh
docker compose -f compose.server.yml exec synapse \
  register_new_matrix_user --exists-ok --no-admin -u codever \
  --password-file /run/secrets/codever_account_password \
  -c /data/homeserver.yaml http://localhost:8008
```

Public registration remains disabled. Back up `data/`, `secrets/`, and the
PostgreSQL volume. Never commit generated secrets.

Gateway and client setup, Matrix SAS verification, and execution-root approval
are documented in [`../../docs/matrix-transport.md`](../../docs/matrix-transport.md).
