# Business E2E acceptance

Codever only calls a test end-to-end when it drives a shipped user interface
through the same deployed components and persistence boundaries used by a
person. Tests that replace Matrix, the Gateway, the native bridge, or the UI
with an in-memory implementation are integration tests, not business E2E.

## Test classes

| Class | Required components | What a pass means |
| --- | --- | --- |
| Unit | One module with controlled dependencies | Local behavior is correct. |
| Protocol integration | Real protocol/client code with fake ports or providers | Signing, replay, conflict, and projection rules compose correctly. |
| Local business E2E | Disposable Synapse, current Gateway process, current PWA in a real browser, deterministic provider | The current source tree completes user journeys over real Matrix and browser storage. |
| Release acceptance | Deployed PWA, installed APK, running Matrix Gateway, real Matrix server, configured ACP provider | The exact released artifacts and their real provider boundary work together after deployment. |

The Vitest files under `e2e/` predate this definition. They are protocol
integration tests and must not be cited as business E2E evidence. They remain
in their existing directory temporarily to avoid an unrelated file move, but
the package scripts label them accurately.

## Mandatory release journeys

Every release must run these journeys against both a normal browser and the
Android APK. Cross-device steps use two independently paired Matrix devices.

1. **Startup and version compatibility**
   - The browser build, APK native build, Gateway build, and Matrix-native
     protocol version are recorded in the result.
   - A client does not report `Connected` from cached state alone. It must
     receive a fresh checkpoint from the running Gateway.
   - An incompatible Gateway fails closed with an actionable update message.
2. **Create and first prompt**
   - A visible pending state appears within 1.5 seconds of confirmation.
   - The session converges on both devices within 15 seconds.
   - A prompt, streamed response, terminal result, and completion notification
     are visible on both devices without manual refresh.
3. **History and restart**
   - Reloading the browser and force-stopping/restarting the APK restore the
     same session and complete history.
   - Older history can be paged without Gateway history RPCs.
4. **Archive, restore, and delete**
   - Each action gives visible feedback within 1.5 seconds and converges within
     15 seconds.
   - Confirming deletion immediately leaves the conversation and removes its
     row locally.
   - The session disappears on the second device, remains absent after reload
     and process restart, and cannot be selected or deleted again.
   - Replaying the same deletion intent is idempotent and does not occupy the
     single-writer command slot.
5. **Offline and recovery**
   - Previously synchronized sessions and history remain readable offline.
   - Commands show a truthful queued state and are delivered once after
     reconnect.
   - Matrix sync restart, delayed lifecycle delivery, and duplicate timeline
     events converge without stale sessions or review deadlocks.
6. **Background Android behavior**
   - The foreground service notification remains present while another app is
     foregrounded.
   - Agent completion produces one notification.
   - Returning to Codever shows current state without a long reconnect.

## Pass and failure rules

- Required infrastructure missing, a scenario skipped, an unexpected alert,
  or a latency budget exceeded is a failure. There is no "pass with warnings".
- Assertions target user-visible outcomes in addition to command completion.
- A successful command is insufficient until the authoritative Matrix event
  has converged on every participating device.
- Each run uses uniquely named disposable sessions and cleans only those
  sessions.
- On failure the runner records build identities, the last DOM state, native
  diagnostics, Gateway logs, screenshots, and the failing command ID.
- Deployment is complete only after release acceptance passes against the
  newly started Gateway process. Running tests against source code while an
  older Gateway remains installed is not acceptance.

## Commands

```bash
# Unit plus protocol integration tests. These do not constitute business E2E.
pnpm test
pnpm test:protocol-integration

# Real installed-APK release acceptance. This intentionally fails unless an
# emulator is connected and explicit mutation permission is supplied.
CODEVER_WEB_LIVE_E2E=1 pnpm test:e2e:web-live

CODEVER_ANDROID_LIVE_E2E=1 \
CODEVER_ANDROID_SERIAL=emulator-5554 \
pnpm test:e2e:android-live

# Full isolated Alpha gate: fresh .e2e APK, two browsers, official Synapse,
# current Gateway, deterministic delayed provider, background notifications,
# cross-device lifecycle, and in-flight recovery.
CODEVER_ALPHA_LIVE_E2E=1 \
CODEVER_ANDROID_SERIAL=emulator-5554 \
pnpm test:e2e:alpha-live
```

The Web runner starts the official disposable Synapse fixture under
`dev/matrix`, builds the current PWA production artifact, serves it through the
local Cloudflare Workers runtime, opens two isolated Chrome contexts, and
starts the current Gateway with a loopback-only deterministic provider. It
never falls back to a fake port or development server. The Android runner
validates the installed APK and the actually deployed Matrix/Gateway path.
The isolated Alpha gate also validates fresh native onboarding. It accepts a
negotiated one-time Matrix login when the homeserver supports that capability,
and otherwise requires the documented new-device username/password fallback
to complete before pairing can continue.

## Automated coverage status

| Journey | Web live runner | Android live runner |
| --- | --- | --- |
| Fresh-device pairing and inventory bootstrap | Two isolated browser devices | Enforced by the isolated Alpha gate |
| Create and immediate feedback | Enforced | Enforced |
| Cross-device prompt and agent response | Enforced | Enforced by the isolated Alpha gate |
| History after reload/process restart | Enforced on both browser devices | Enforced for cached history |
| Archive, restore, and delete | Delete enforced on both devices | Full lifecycle enforced twice |
| Offline read and network recovery | Enforced by the isolated Alpha gate | Enforced with airplane mode |
| Android foreground-service and completion notifications | Not applicable | Enforced by the isolated Alpha gate |

An unimplemented cell is not implicitly passed. Web local business E2E may be
green while the overall release acceptance remains incomplete. The Alpha gate
uses an application-id-suffixed APK which can coexist with the normal APK. Its
native bridge accepts only the compiled loopback origin and reaches disposable
PWA and Synapse fixtures through `adb reverse`; it never reuses a person's
paired account. A distributable APK still has to pass the installed release
runner against the newly deployed production components.
