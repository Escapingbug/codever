# Real Matrix testing

CVP/3 has one release-blocking Alpha journey and a smaller browser-only
diagnostic journey. Both use a disposable real Synapse server and the actual
built PWA/Gateway. Unit tests or mocked Matrix transports are not release
acceptance.

## Prerequisites

- Docker is running.
- Node.js 22 or newer and workspace dependencies are installed.
- Chromium/Chrome is available to Playwright.
- An Android emulator or physical device is visible to `adb`.

The fixture binds Synapse to a random localhost port and writes all accounts,
keys, Gateway state, browser state, screenshots, and APK artifacts to isolated
temporary/test directories. It never uses the deployed Gateway or the user's
normal APK application ID.

## Release-blocking Alpha acceptance

Set the exact Android serial, then run:

```bash
CODEVER_ANDROID_SERIAL=emulator-5554 pnpm test:e2e:alpha-live
```

`test:e2e:alpha-live` requires Android. It fails immediately if the serial is
missing, so a browser-only run cannot be mistaken for complete acceptance.

The journey proves, through real UI and Matrix traffic:

1. A cache-cold browser pairs and sees the room-bound project identity.
2. It creates a session, sends a prompt, receives Agent output, and creates a
   second session while the first Agent turn is still running.
3. A second independent browser pairs and restores inventory and transcript
   without a manual refresh or application checkpoint.
4. The isolated Android APK installs, pairs, restores existing history, and
   creates a session that appears in the browser.
5. Android sends a prompt, the Activity moves to the background, the foreground
   service receives the terminal Agent result, and a task notification appears.
6. Android is force-stopped and restarted, then restores its durable projection
   and history without resending the command.
7. Android deletes a session and the browser converges.
8. A deliberately malformed CVP/3 event is quarantined without blocking the next
   valid event.
9. Browser reload/history recovery and concurrent deletion converge on both
   browser devices.

A successful Android sub-journey ends with:

```text
PASS — Android CVP/3 paired, restored, ran in background, notified, restarted, and deleted.
```

The complete run ends with:

```text
PASS — CVP/3 over Matrix paired, created, ran concurrently, synchronized, restored, quarantined poison, and deleted.
```

Artifacts for a failed run are retained under `artifacts/e2e/matrix-cvp3-*`.

## Browser-only diagnostic journey

When no Android target is available, the browser/Synapse/Gateway portion can be
run explicitly:

```bash
CODEVER_MATRIX_CVP3_LIVE_E2E=1 pnpm test:e2e:matrix-cvp3-live
```

This command is useful during browser or Gateway development, but it is not the
Alpha release gate.

## Manual local development

Start the PWA and local Gateway in separate terminals:

```bash
cd apps/pwa && pnpm dev
```

```bash
pnpm dev:matrix-gateway
```

The Gateway prints a QR code, invitation code, and pasteable fallback link.
Use **Add a Gateway** in a fresh browser profile, confirm the matching
invitation code, and complete the Matrix login offered by the invitation. One
Matrix room is one project; new sessions appear as threads in that project.

Manual checks are useful for visual quality and provider-specific behavior,
but do not replace the isolated Alpha journey. Never point the disposable test
scripts at the production room or production Gateway data directory.

## Acceptance boundaries

- One Codever tab owns one Matrix crypto store. A full-lifetime Web Lock rejects
  another tab before the two can share a Rust crypto database.
- Android uses the isolated `id.my.anciety.codever.e2e` application ID and
  `app-e2e.apk`; acceptance must not overwrite the user's installed data.
- Raw Matrix events are durable before projection, and a `/sync` token is saved
  only after accepted events have been handled.
- Thread enumeration and history are fully paginated. A bounded initial sync is
  not evidence that all sessions or history were restored.
- Repeated Gateway/session updates must converge through `/sync` without
  issuing selected-thread relation requests. A cached reload, focus change,
  foreground transition, and ordinary network recovery must also issue zero
  recent-history requests.
- A deliberately limited `/sync` must persist and close its gap in the
  background while cached history remains readable; it must not make the
  WebView wait for a history RPC.
- The foreground Android service, not the WebView, owns background sync and
  notifications.
- Only CVP/3 application data is accepted. Pairing and signed Gateway
  transport rotation are separate control-plane operations.
