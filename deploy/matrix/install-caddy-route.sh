#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run install-caddy-route.sh with sudo." >&2
    exit 1
fi

CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"
CANDIDATE="$(mktemp)"
trap 'rm -f "$CANDIDATE"' EXIT

if grep -q '@codever_matrix path' "$CONFIG"; then
    cp "$CONFIG" "$CANDIDATE"
else
    awk '
        BEGIN { inserted = 0 }
        !inserted && /reverse_proxy 127[.]0[.]0[.]1:3005/ {
            print "        @codever_matrix path /_matrix/* /_synapse/client/*"
            print "        reverse_proxy @codever_matrix 127.0.0.1:8008"
            print ""
            inserted = 1
        }
        { print }
        END { if (!inserted) exit 42 }
    ' "$CONFIG" > "$CANDIDATE"
fi

caddy validate --adapter caddyfile --config "$CANDIDATE"
cp "$CONFIG" "${CONFIG}.before-codever-matrix"
install -o root -g root -m 644 "$CANDIDATE" "$CONFIG"
systemctl reload caddy
