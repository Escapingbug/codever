#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run install-caddy-route.sh with sudo." >&2
    exit 1
fi

CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"
SITE_ADDRESS="${CODEVER_PWA_SITE_ADDRESS:-rd.anciety.my.id}"
CANDIDATE="$(mktemp)"
trap 'rm -f "$CANDIDATE"' EXIT

install -d -o root -g root -m 755 \
    /srv/codever-native-updates/releases/android/alpha

if grep -q '# Codever native updates' "$CONFIG"; then
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
                print "\t# Codever native updates"
                print "\thandle_path /native-updates/releases/* {"
                print "\t\troot * /srv/codever-native-updates/releases"
                print "\t\theader Cache-Control \"public, max-age=31536000, immutable\""
                print "\t\tfile_server"
                print "\t}"
                print ""
                inserted = 1
            }
        }
        END { if (!inserted) exit 42 }
    ' "$CONFIG" > "$CANDIDATE"
fi

caddy validate --adapter caddyfile --config "$CANDIDATE"
cp "$CONFIG" "${CONFIG}.before-codever-native-updates"
install -o root -g root -m 644 "$CANDIDATE" "$CONFIG"
systemctl reload caddy
