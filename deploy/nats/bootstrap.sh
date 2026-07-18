#!/bin/sh
set -eu

root="${CODEVER_SECURITY_ROOT:-/data/security}"
relay_data="${CODEVER_RELAY_DATA_ROOT:-/data/relay}"
operator="${CODEVER_NSC_OPERATOR:-CODEVER}"
account="${CODEVER_NSC_ACCOUNT:-CODEVER}"
marker="$root/.bootstrapped-v1"
config_dir="$root/config"
store_dir="$root/store"
keys_dir="$root/keys"

run_nsc() {
    nsc --config-dir "$config_dir" --data-dir "$store_dir" --keystore-dir "$keys_dir" "$@"
}

mkdir -p "$root" "$relay_data"
if [ -f "$marker" ]; then
    test -s "$root/resolver.conf"
    test -s "$root/relay-admin.creds"
    chown -R 1000:1000 "$root" "$relay_data"
    exit 0
fi

if [ "$(find "$root" -mindepth 1 -maxdepth 1 | wc -l)" -ne 0 ]; then
    echo "Refusing to initialize a non-empty security directory without $marker" >&2
    exit 1
fi

mkdir -p "$config_dir" "$store_dir" "$keys_dir"
run_nsc add operator --name "$operator" --sys --generate-signing-key
run_nsc env --operator "$operator"
run_nsc add account --name "$account"
run_nsc edit account --name "$account" --js-enable 0
run_nsc edit account --name "$account" \
    --js-tier 0 --js-disk-storage=-1 --js-mem-storage=-1 \
    --js-streams=-1 --js-consumer=-1
run_nsc add user --account "$account" --name relay-admin --allow-pubsub ">"
run_nsc generate creds --account "$account" --name relay-admin \
    --output-file "$root/relay-admin.creds"
run_nsc generate config --mem-resolver --config-file "$root/resolver.conf" --force

chmod 600 "$root/relay-admin.creds"
touch "$marker"
chown -R 1000:1000 "$root" "$relay_data"
