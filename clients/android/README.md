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
  class names. Exported reports never include tokens, message content, room/user
  identifiers, device keys, raw SDK messages, or free-form exception messages.
- Explicit Disconnect finishes the native runtime before stopping the service.
  Remove This Device requires a native confirmation, logs the Matrix device out
  while online, and only then wipes local credentials. A failed remote logout
  fails closed and retains the local identity so revocation cannot be falsely
  reported as complete.

Android's explicit force-stop remains a platform override: no application can
restart itself until the user opens it again.

`CodeverApplication` initializes the Matrix FFI platform and its multithreaded
Tokio runtime before an Activity, boot receiver, or connection service can open
a client. Every client explicitly uses the SDK's single-process store mode. The
Matrix SDK `SyncService` then supervises native sliding sync for both the room
list and encryption.

Existing v2 sessions are migrated to the native sliding-sync session mode while
preserving the Matrix crypto/data store and Codever pairing identity. Only the
disposable SDK cache is rotated to `cache-v2`, and the room list uses the
versioned `codever-native-v2` connection ID. The bound room is subscribed before
the service starts. `SyncService.RUNNING` means only that its child tasks were
spawned; readiness requires room-list progress from a completed sync before
E2EE finalization, timeline construction, and transport publication. A running
supervisor that produces no first sync within 45 seconds is blocked instead of
entering an unbounded restart loop.

The SDK writes bounded private sync traces. Diagnostic export converts those
traces to a fixed vocabulary of levels, targets, categories, and HTTP status
codes; raw SDK messages and identifiers never enter the shared report.

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

For a paired debug APK on an emulator, the live device E2E drives the real
WebView through its debug protocol and the Android lifecycle through ADB. It
cold-starts online and offline, verifies cached conversations and history,
restores the native Matrix connection, and runs two complete
create/archive/restore/delete cycles. It creates uniquely named disposable
projects and only deletes sessions created by that run. Lifecycle operations
remain correctness failures after 90 seconds and are also reported as latency
warnings when they exceed 20 seconds. The opt-in guard keeps it out of normal
test runs:

```sh
CODEVER_ANDROID_LIVE_E2E=1 pnpm test:e2e:android-live
```

The command requires exactly one connected emulator by default. Set
`CODEVER_ANDROID_SERIAL` when several devices are attached. Physical-device
mutation is rejected unless `CODEVER_ANDROID_ALLOW_PHYSICAL=1` is also set
after explicit approval.

## Remaining release work

- Complete the remaining physical-device Matrix/E2EE release checks: screen
  lock, reboot, device revocation, and prolonged OEM background restrictions.
- Make attachment transfer metadata process-durable. Current temporary chunks
  are encrypted, but an interrupted process discards orphan transfer state and
  the UI must restart that transfer.
- Add session-specific notification deep links and product message
  notifications; the current ongoing notification opens the main Activity.
- Produce a signed release APK and define signing-key custody and an APK update
  channel. The current artifact is debug-signed only.
- Validate the `remoteMessaging` classification with Google Play policy before
  Play distribution. Directly distributed APKs do not undergo that review.
