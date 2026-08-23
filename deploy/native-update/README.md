# Gateway-published native client releases

The deployment server stores immutable APK files, while the running Gateway
publishes the latest Android release to its paired account. Release discovery
uses the existing CVP workspace snapshot and Matrix synchronization; it has no
public manifest, update polling interval, or second update-signing key.

The Android host receives the current account release while its normal
background Gateway connection is active. It resumes the APK download, verifies
the hash, package name, version, architecture, and Android signing certificate,
then hands the APK to `PackageInstaller`. An offline client receives only the
latest workspace release after reconnecting, not a backlog of update messages.

## One-time server setup

Install the immutable release route inside the existing HTTPS site:

```sh
sudo deploy/native-update/install-caddy-route.sh
```

The route serves only `/native-updates/releases/...` with immutable caching.
There is no public latest-version endpoint.

## Build a release bundle

Use one stable Android application-signing key for every Alpha APK. Supply all
four variables to Gradle; the bundle generator rejects an unsigned APK.

```sh
cd clients/android
CODEVER_ANDROID_SIGNING_STORE_FILE=/secure/codever-alpha.jks \
CODEVER_ANDROID_SIGNING_STORE_PASSWORD=... \
CODEVER_ANDROID_SIGNING_KEY_ALIAS=codever-alpha \
CODEVER_ANDROID_SIGNING_KEY_PASSWORD=... \
./gradlew :app:assembleRelease

cd ../..
pnpm release:android-update -- \
  --apk clients/android/app/build/outputs/apk/release/app-release.apk \
  --release-note "Background connection reliability improvements"
```

This creates an immutable APK below `dist/native-update/releases/...` and a
local `dist/native-update/client-release.json`. The JSON is deployment input,
not a public manifest.

## Upload and publish through the Gateway

The checked publisher uploads the APK first, verifies the remote hash, then
submits `client-release.json` to the owner-only Gateway admin socket. The
Gateway durably records the latest account release and replaces the encrypted
workspace snapshot. Retrying the same release is idempotent; changing an
already published version or moving backward is rejected.

```sh
pnpm publish:android-update -- \
  dist/native-update \
  ubuntu@rd.anciety.my.id \
  /absolute/path/to/gateway-data/admin.sock
```

The admin socket path can instead be supplied through
`CODEVER_NATIVE_UPDATE_ADMIN_SOCKET`.

## Android signing transition

Android itself only accepts an in-place update signed by the same application
key as the installed APK. Existing development APKs are debug-signed, so the
first move to the stable Alpha application key needs one manual reinstall (or
uninstall/install if Android rejects the key change). After that transition,
Gateway-published releases update in place. Losing the Android signing key
prevents future in-place upgrades; no separate Codever update key exists.
