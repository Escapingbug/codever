#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run bootstrap.sh with sudo so Synapse data can be owned by container UID 991." >&2
    exit 1
fi

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SERVER_NAME="${CODEVER_MATRIX_SERVER_NAME:-rd.anciety.my.id}"
DATA="$ROOT/data"
SECRETS="$ROOT/secrets"

mkdir -p "$DATA" "$SECRETS"
chmod 700 "$DATA" "$SECRETS"

ensure_secret() {
    path="$1"
    if [ ! -s "$path" ]; then
        umask 077
        openssl rand -hex 32 > "$path"
    fi
}

ensure_secret "$SECRETS/postgres-password"
ensure_secret "$SECRETS/macaroon-secret"
ensure_secret "$SECRETS/form-secret"
ensure_secret "$SECRETS/registration-secret"
ensure_secret "$SECRETS/codever-account-password"

escape_sed() {
    printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

sed \
    -e "s|__SERVER_NAME__|$(escape_sed "$SERVER_NAME")|g" \
    -e "s|__POSTGRES_PASSWORD__|$(escape_sed "$(cat "$SECRETS/postgres-password")")|g" \
    -e "s|__MACAROON_SECRET__|$(escape_sed "$(cat "$SECRETS/macaroon-secret")")|g" \
    -e "s|__FORM_SECRET__|$(escape_sed "$(cat "$SECRETS/form-secret")")|g" \
    -e "s|__REGISTRATION_SECRET__|$(escape_sed "$(cat "$SECRETS/registration-secret")")|g" \
    "$ROOT/homeserver.yaml.template" > "$DATA/homeserver.yaml"
cp "$ROOT/log.config" "$DATA/log.config"
chmod 600 "$DATA/homeserver.yaml" "$DATA/log.config" "$SECRETS"/*
chown -R 991:991 "$DATA"
chmod 700 "$DATA"

echo "Prepared private Matrix configuration for $SERVER_NAME"
