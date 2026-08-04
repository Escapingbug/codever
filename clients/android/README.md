# Codever Android native host

This is the Android-first native host for the continuously updated Codever UI
at `https://rd.anciety.my.id`. It is a Kotlin Android application; it does not
use Tauri and does not bundle a second offline frontend.

The browser PWA remains a complete standalone client. Inside the APK, the same
hosted UI selects the native client only after a strict capability handshake
and after the Matrix session has been bootstrapped as native-owned. A
browser-owned Matrix session continues to use the Web client, which prevents
one identity from being driven by both transports.

## Runtime and lifecycle

- The main Activity loads only the exact production HTTPS origin in a secured
  WebView. Compatible UI releases arrive through the existing online update
  path without installing another APK.
- AndroidX WebKit exposes an origin-restricted, main-frame-only JSON-RPC port.
  The application never uses `addJavascriptInterface`.
- `CodeverConnectionService` owns Matrix SDK login, E2EE, native sliding sync,
  the bound
  room timeline, Codever trust, replay state, commands, history, and transfers.
- The service is `START_STICKY`, restores after reboot when persistent
  connection is enabled, and stays alive when the Activity/WebView is closed or
  replaced.
- A visible ongoing `remoteMessaging` notification is mandatory. There is no
  battery-saving or connection-mode selector. Refusing notification permission
  blocks native connection startup with a visible explanation.
- The ongoing notification exposes **Export logs**. It creates a bounded text
  report that can be shared directly to Telegram even when the hosted Web UI
  cannot connect. Reports contain the exact APK build, Android version, native
  lifecycle transitions, Matrix startup stages, timeouts, retries, and exception
  class names. Tokens, message content, room/user identifiers, device keys, and
  free-form exception messages are never recorded.
- Explicit Disconnect finishes the native runtime before stopping the service.
  Remove This Device requires a native confirmation, logs the Matrix device out
  while online, and only then wipes local credentials. A failed remote logout
  fails closed and retains the local identity so revocation cannot be falsely
  reported as complete.

Android's explicit force-stop remains a platform override: no application can
restart itself until the user opens it again.

The Matrix SDK `SyncService` supervises native sliding sync for both the room
list and encryption. Existing v2 sessions are migrated in place to the native
sliding-sync session mode. The bound room is subscribed before the service
starts, and the room-list state must reach `RUNNING` before E2EE finalization,
timeline construction, and transport readiness. Startup has a 30-second driver
deadline, while the connection watchdog still enforces a 45-second first-sync
deadline and trusts the SDK supervisor for ongoing sync health. This prevents a
started service or blocked timeline initialization from leaving the public
lifecycle in `connecting` indefinitely.

## Native capabilities

Bridge protocol version 1 currently implements:

- `client.lifecycle`
- `events.replay`
- `state.snapshot`
- `commands.durable`
- `history.page`
- `attachments.chunked`
- `pairing.native`
- `trust.native`
- `matrix.session-bootstrap`
- `background.foreground-service`

The bridge has strict schemas, a 512 KiB RPC envelope limit, 256 KiB event
batches, mutation idempotency, cursor replay with snapshot fallback, and
chunked attachments up to 50 MiB. Reconnect snapshots reserve their budget for
active commands and terminal summaries; large terminal results remain
recoverable through `codever.command.get`.

Pairing uses a native confirmation dialog. Signed pairing rejection, request
binding, Gateway root trust, transport-device rotation, and durable signed
transport snapshots are verified before changing trust. Commands are validated
and authorized against the current Gateway certificate before entering the
encrypted durable outbox. History first replays the encrypted local event
store, then requests authenticated Gateway pages when needed.

## Secret handling

- The Matrix one-time login token is memory-only and is exchanged only with the
  exact HTTPS homeserver login endpoint.
- Matrix access tokens, Codever private keys, SDK database keys, and raw Matrix
  events never cross the JavaScript bridge.
- Codever P-256 signing/agreement keys are non-exportable Android Keystore keys.
- Long-lived Matrix session data, Gateway trust, command outbox, event state,
  raw journal, and attachment temporary chunks are encrypted at rest.
- Cleartext traffic, mixed content, file/content access, wildcard bridge
  origins, external frames, redirects during sensitive profile recovery, and
  TLS/certificate errors fail closed.

## Build and validation

The first APK supports Android 12 or newer (`minSdk 31`) and arm64. Set
`ANDROID_HOME` to an SDK containing API 36 and use JDK 17:

```sh
./gradlew --no-build-cache --rerun-tasks -Pkotlin.incremental=false \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. The
Matrix native libraries make it substantially larger than a WebView-only shell.
An unstrippable JNA native library is packaged as-is by the current dependency.

Every APK has its own build identity. `versionCode` advances with build time
(seconds since 2020-01-01), while `versionName` and the native bridge build ID
include the millisecond UTC build timestamp, Git revision, and a `dirty` suffix
when tracked source changes were present. Set
`CODEVER_ANDROID_BUILD_EPOCH_MS` to an epoch timestamp in milliseconds when CI
needs a reproducible identity. The exact identity is visible in Android App
info, the persistent notification, and the PWA Gateway settings. This lets a
pairing failure screenshot identify the installed native binary independently
of the online PWA build.

The JVM suite covers bridge negotiation and cancellation, pairing/trust and
cross-language crypto fixtures, transport rotation recovery, durable commands,
event persistence/replay, encrypted transfers, Matrix login/runtime recovery,
and lifecycle policy. The PWA has separate bridge selection, conformance, and
online-update tests.

## Remaining release work

- Run a live Matrix/E2EE smoke test on an arm64 Android 12+ device, including
  screen lock, Activity removal, network switching, process death, reboot,
  remote command completion, and device revocation.
- Make attachment transfer metadata process-durable. Current temporary chunks
  are encrypted, but an interrupted process discards orphan transfer state and
  the UI must restart that transfer.
- Add session-specific notification deep links and product message
  notifications; the current ongoing notification opens the main Activity.
- Produce a signed release APK and define signing-key custody and an APK update
  channel. The current artifact is debug-signed only.
- Validate the `remoteMessaging` classification with Google Play policy before
  Play distribution. Directly distributed APKs do not undergo that review.
