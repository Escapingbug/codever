#!/bin/sh
set -eu

BUNDLE_ROOT="${1:-}"
SSH_TARGET="${2:-${CODEVER_NATIVE_UPDATE_SSH_TARGET:-}}"
ADMIN_SOCKET="${3:-${CODEVER_NATIVE_UPDATE_ADMIN_SOCKET:-}}"
SSH_IDENTITY_FILE="${CODEVER_NATIVE_UPDATE_SSH_IDENTITY_FILE:-}"
if [ -z "$BUNDLE_ROOT" ] || [ -z "$SSH_TARGET" ] || [ -z "$ADMIN_SOCKET" ]; then
    echo "Usage: publish.sh <bundle-root> <user@host> <gateway-admin-socket>" >&2
    exit 1
fi
case "$SSH_TARGET" in
    *[!A-Za-z0-9._@:-]*|*@*@*|@*|*@) echo "Invalid SSH target." >&2; exit 1 ;;
esac
case "$ADMIN_SOCKET" in
    /*) ;;
    *) echo "Gateway admin socket path must be absolute." >&2; exit 1 ;;
esac
case "$ADMIN_SOCKET" in
    *[!A-Za-z0-9_./-]*|*[.][.]*) echo "Invalid Gateway admin socket path." >&2; exit 1 ;;
esac
if [ -n "$SSH_IDENTITY_FILE" ]; then
    case "$SSH_IDENTITY_FILE" in
        /*) ;;
        *) echo "SSH identity file path must be absolute." >&2; exit 1 ;;
    esac
    case "$SSH_IDENTITY_FILE" in
        *[!A-Za-z0-9_./-]*|*[.][.]*) echo "Invalid SSH identity file path." >&2; exit 1 ;;
    esac
    [ -f "$SSH_IDENTITY_FILE" ] || {
        echo "SSH identity file does not exist: $SSH_IDENTITY_FILE" >&2
        exit 1
    }
fi

run_ssh() {
    if [ -n "$SSH_IDENTITY_FILE" ]; then
        ssh -i "$SSH_IDENTITY_FILE" "$@"
    else
        ssh "$@"
    fi
}

run_scp() {
    if [ -n "$SSH_IDENTITY_FILE" ]; then
        scp -i "$SSH_IDENTITY_FILE" "$@"
    else
        scp "$@"
    fi
}

RELEASE="$BUNDLE_ROOT/client-release.json"
if [ ! -f "$RELEASE" ]; then
    echo "Gateway client release is missing: $RELEASE" >&2
    exit 1
fi

METADATA="$(node - "$RELEASE" <<'NODE'
const fs = require('node:fs');
const release = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const url = new URL(release.artifact?.url);
const expected = `/native-updates/releases/android/alpha/${release.versionCode}/`;
if (
  release.platform !== 'android' || release.channel !== 'alpha' ||
  release.architecture !== 'arm64-v8a' ||
  !Number.isSafeInteger(release.versionCode) || release.versionCode < 1 ||
  url.origin !== 'https://rd.anciety.my.id' ||
  !url.pathname.startsWith(expected) || url.search || url.hash ||
  !Number.isSafeInteger(release.artifact?.size) || release.artifact.size < 1 ||
  !/^[0-9a-f]{64}$/.test(release.artifact?.sha256 ?? '')
) throw new Error('Invalid Android Alpha client release.');
const relative = url.pathname.slice('/native-updates/'.length);
if (!/^releases\/android\/alpha\/[1-9][0-9]*\/[A-Za-z0-9._+-]+\.apk$/.test(relative)) {
  throw new Error('Unsafe update artifact path.');
}
process.stdout.write([
  String(release.versionCode),
  relative,
  release.artifact.sha256,
  String(release.artifact.size),
  release.artifact.url,
].join('\n'));
NODE
)"
VERSION_CODE="$(printf '%s\n' "$METADATA" | sed -n '1p')"
ARTIFACT_RELATIVE="$(printf '%s\n' "$METADATA" | sed -n '2p')"
EXPECTED_SHA256="$(printf '%s\n' "$METADATA" | sed -n '3p')"
EXPECTED_SIZE="$(printf '%s\n' "$METADATA" | sed -n '4p')"
ARTIFACT_URL="$(printf '%s\n' "$METADATA" | sed -n '5p')"
ARTIFACT="$BUNDLE_ROOT/$ARTIFACT_RELATIVE"
if [ ! -f "$ARTIFACT" ]; then
    echo "Versioned APK is missing: $ARTIFACT" >&2
    exit 1
fi
ACTUAL_SHA256="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
ACTUAL_SIZE="$(wc -c < "$ARTIFACT" | tr -d ' ')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ] || [ "$ACTUAL_SIZE" != "$EXPECTED_SIZE" ]; then
    echo "Versioned APK does not match its Gateway release metadata." >&2
    exit 1
fi

REMOTE_STAGE="/tmp/codever-native-update-${VERSION_CODE}-$$"
cleanup() {
    run_ssh "$SSH_TARGET" "rm -rf '$REMOTE_STAGE'" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
run_ssh "$SSH_TARGET" "install -d -m 700 '$REMOTE_STAGE'"
run_scp "$ARTIFACT" "$SSH_TARGET:$REMOTE_STAGE/artifact.apk"

run_ssh "$SSH_TARGET" sudo sh -s -- \
    "$REMOTE_STAGE" "$ARTIFACT_RELATIVE" "$EXPECTED_SHA256" <<'REMOTE'
set -eu
STAGE="$1"
ARTIFACT_RELATIVE="$2"
EXPECTED_SHA256="$3"
ROOT=/srv/codever-native-updates
TARGET="$ROOT/$ARTIFACT_RELATIVE"
case "$TARGET" in
    "$ROOT"/releases/android/alpha/[1-9][0-9]*/*.apk) ;;
    *) echo "Unsafe remote artifact path." >&2; exit 1 ;;
esac
install -d -o root -g root -m 755 "$(dirname "$TARGET")"
STAGED_SHA256="$(sha256sum "$STAGE/artifact.apk" | awk '{print $1}')"
[ "$STAGED_SHA256" = "$EXPECTED_SHA256" ] || {
    echo "Staged APK hash mismatch." >&2
    exit 1
}
if [ -e "$TARGET" ]; then
    EXISTING_SHA256="$(sha256sum "$TARGET" | awk '{print $1}')"
    [ "$EXISTING_SHA256" = "$EXPECTED_SHA256" ] || {
        echo "Refusing to overwrite an immutable APK." >&2
        exit 1
    }
else
    install -o root -g root -m 644 "$STAGE/artifact.apk" "$TARGET"
fi
REMOTE

# Do not advertise a release until the same URL Android will use is reachable.
curl --fail --silent --show-error --head "$ARTIFACT_URL" >/dev/null

# The owner-only Gateway interface is local to the deployment operator, while
# SSH_TARGET is only the immutable artifact host. This matches deployments
# where a desktop Gateway publishes to its paired account and a separate HTTPS
# server stores the APK. Do not copy the owner-only socket or publication
# authority onto the public server.
curl --fail --silent --show-error --unix-socket "$ADMIN_SOCKET" \
    -H 'content-type: application/json' \
    --data-binary "@$RELEASE" \
    http://localhost/v1/client-releases/android

trap - EXIT INT TERM
cleanup
echo "Published Android Alpha update $VERSION_CODE through the local Gateway; artifact host: $SSH_TARGET."
