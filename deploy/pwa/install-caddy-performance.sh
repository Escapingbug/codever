#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run install-caddy-performance.sh with sudo." >&2
    exit 1
fi

CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"
SITE_ADDRESS="${CODEVER_PWA_SITE_ADDRESS:-rd.anciety.my.id}"
CANDIDATE="$(mktemp)"
trap 'rm -f "$CANDIDATE"' EXIT

if grep -q '# Codever PWA performance' "$CONFIG"; then
    cp "$CONFIG" "$CANDIDATE"
else
    awk -v site_address="$SITE_ADDRESS" '
        BEGIN { inserted = 0 }
        {
            line = $0
            sub(/^[[:space:]]*/, "", line)
            sub(/[[:space:]]*$/, "", line)
            print $0
            if (!inserted && line == site_address " {") {
                print "\t# Codever PWA performance"
                print "\tencode zstd gzip"
                print ""
                print "\t@codever_service_worker path /sw.js"
                print "\theader @codever_service_worker Cache-Control \"no-cache, no-store, must-revalidate\""
                print ""
                inserted = 1
            }
        }
        END { if (!inserted) exit 42 }
    ' "$CONFIG" > "$CANDIDATE"
fi

caddy validate --adapter caddyfile --config "$CANDIDATE"
cp "$CONFIG" "${CONFIG}.before-codever-pwa-performance"
install -o root -g root -m 644 "$CANDIDATE" "$CONFIG"
systemctl reload caddy
