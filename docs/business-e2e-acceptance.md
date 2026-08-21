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
   authenticate current Matrix Room State from the running Gateway.
   - An incompatible Gateway fails closed with an actionable update message.
   - A device paired before new mandatory session-lifecycle capabilities were
     introduced upgrades its authorization without losing its identity or
     entering an unrecoverable durable-command retry loop.
2. **Create and first prompt**
   - A visible pending state appears within 1.5 seconds of confirmation.
   - The session converges on both devices within 15 seconds.
   - A prompt, streamed response, terminal result, and completion notification
     are visible on both devices without manual refresh.
   - Text-file and image attachments are selected through the shipped file
     input. The Agent response must contain a unique marker that exists only in
     the attachment bytes, proving the Agent received and processed the content.
3. **History and restart**
   - Reloading the browser and force-stopping/restarting the APK restore the
     same session and complete history.
   - A previously paired browser whose local CVP/3 read model is erased keeps
     its Matrix login, device identity, and pinned Gateway trust. If another
     device creates a session while it is offline, startup must restore the
     complete authoritative inventory. While the current snapshot is delayed,
     it must show recovery—not `Connected` or an empty-inventory call to action.
   - If authoritative recovery fails, a later successful Matrix `/sync` must
     not hide the failure or report `Connected`; recovery remains actionable
     until the CVP/3 snapshot and session directory have actually converged.
   - A populated local conversation opens without any Matrix thread-relation
     request. Focus, foreground, network recovery, and 150 consecutive remote
     updates still use zero recent-history requests and arrive exactly once
     through the incremental event stream.
   - Older history can be paged without Gateway history RPCs.
   - A cache-cold client restores history through the selected session's Matrix
     thread only; normal Android startup requests zero room-timeline items.
   - Killing the Android process after a live batch is received but before its
     Matrix cursor is committed causes redelivery and exactly-once local
     projection after restart, not message loss or duplication.
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
   - Losing acknowledgement and terminal-result delivery after the Gateway
     commits a create/delete command does not strand the native durable outbox.
     Recovery must still work when Matrix transaction deduplication is no
     longer available, and the next create/delete must start immediately.
   - Matrix sync restart, delayed lifecycle delivery, and duplicate timeline
     events converge without stale sessions or review deadlocks.
   - A limited Matrix `/sync` persists its gap before the live cursor advances,
     closes the gap in the background after process restart, and never blocks
     the WebView history bridge or duplicates projected messages.
   - When another device advances the Gateway with a prompt while Android is
     stale, Android's append-only prompt is linearly accepted at the next revision,
     reaches the Agent exactly once, and never shows revision review or a
     connection failure. State-dependent mutations retain explicit review.
6. **Background Android behavior**
   - The foreground service notification remains present while another app is
     foregrounded.
   - Agent completion produces one notification.
   - Returning to Codever shows current state without a long reconnect.
7. **Privacy-protected session**
   - The installed HaS extension is visible but off by default; direct sessions
     remain usable while it is disabled. Enabling it requires its declarative
     privacy context, and review defaults to on.
   - The immutable privacy binding and safe badge converge across devices. No
     extension endpoint, bearer token, context ID, mapping version, or process
     detail appears in PWA Gateway state.
   - Before every protected Agent request, the shipped UI shows the exact
     sanitized text and the extension-provided **Send to Agent** and **Cancel**
     actions. The preview contains the pseudonym and not the source entity.
   - Cancelling the preview produces zero provider invocations. Approval sends
     only the sanitized text to the provider, while streamed provider output is
     restored locally before display on both collaborating devices.
   - Stopping the bound extension blocks the protected turn with a visible
     error and zero provider invocations. An unbound session continues to work;
     restarting the extension resumes the protected session without removing
     or changing its binding.
   - Browser reload and APK process restart restore the protected transcript.
     Deleting the protected session converges across devices.
   - The mapping vault contains authenticated ciphertext, and its audit log is
     metadata-only. Neither artifact may contain the source entity, privacy
     context ID, or prompt plaintext.

## Pass and failure rules

- Required infrastructure missing, a scenario skipped, an unexpected alert,
  or a latency budget exceeded is a failure. There is no "pass with warnings".
- Assertions target user-visible outcomes in addition to command completion.
- A successful command is insufficient until the authoritative Matrix event
  has converged on every participating device.
- Each run uses uniquely named disposable sessions and cleans only those
  sessions.
- On failure the runner records build identities, the last DOM state, native
  diagnostics, Gateway and privacy-extension logs, screenshots, and the
  failing command ID. Provider-boundary assertions use content digests so the
  Gateway log does not become another plaintext sink.
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

# Real browser/Gateway recovery across a Matrix /sync stall longer than the
# command lifetime and watchdog boundary, without restarting the Agent runtime.
CODEVER_SYNC_STALL_E2E=1 pnpm test:e2e:web-sync-stall

CODEVER_ANDROID_LIVE_E2E=1 \
CODEVER_ANDROID_SERIAL=emulator-5554 \
pnpm test:e2e:android-live

# Full isolated Alpha gate: fresh .e2e APK, two browsers, official Synapse,
# current Gateway, deterministic delayed provider, background notifications,
# cross-device lifecycle, in-flight recovery, and long Matrix /sync stall
# recovery.
CODEVER_ALPHA_LIVE_E2E=1 \
CODEVER_ANDROID_SERIAL=emulator-5554 \
pnpm test:e2e:alpha-live
```

The Web runner starts an official disposable Synapse fixture with a per-run
container, data directory, and host port, builds the current PWA production
artifact, serves it through the
local Cloudflare Workers runtime, opens two isolated Chrome contexts, and
starts the current Gateway with a loopback-only deterministic provider. It
never falls back to a fake port or development server. Concurrent worktrees
therefore cannot replace each other's Synapse fixture or invalidate each
other's Matrix access tokens. The Android runner
validates the installed APK and the actually deployed Matrix/Gateway path.
The isolated Alpha gate also validates fresh native onboarding. It accepts a
negotiated one-time Matrix login when the homeserver supports that capability,
and otherwise requires the documented new-device username/password fallback
to complete before pairing can continue.

The privacy fixture is not a fake extension port. The live runner starts the
shipped `extensions/has-privacy` service as a child process, communicates with
it over the authenticated loopback HTTP boundary, and gives it a deterministic
loopback OpenAI-compatible recognition server. The request still crosses the
production PWA, encrypted Matrix room, Gateway, session runtime, extension
process, provider boundary, durable Matrix history, and independent browser or
APK storage.

## Automated coverage status

| Journey | Web live runner | Android live runner |
| --- | --- | --- |
| Fresh-device pairing and inventory bootstrap | Two isolated browser devices | Enforced by the isolated Alpha gate |
| Previously paired device gains current lifecycle capabilities | Enforced with a legacy signed capability set and an exactly-once delete | Enforced in `scripts/web-live-e2e.ts` |
| Create and immediate feedback | Enforced | Enforced |
| Cross-device prompt and agent response | Enforced | Enforced by the isolated Alpha gate |
| Text-file and image content reaches the Agent | Enforced | Not yet enforced |
| History after reload/process restart | Enforced on both browser devices, including an erased CVP/3 read model with delayed and failed authoritative recovery | Enforced for cached history; Alpha also creates on Android while the trusted browser is read-model-cold and offline |
| Archive, restore, and delete | Delete enforced on both devices; deleting the only session remains empty across reload without transient reselection or replacement creation | Full lifecycle enforced twice |
| Offline read and network recovery | Enforced by the isolated Alpha gate | Enforced with airplane mode |
| Post-commit ACK/result loss and durable-outbox release | Not applicable | Enforced by the isolated Alpha gate for create and delete |
| Gateway restart over a legacy durable Room State outbox | Enforced: the persisted Gateway state is downgraded to the pre-command-cursor shape before restart, then active work and a queued create must recover | Shared Gateway path is exercised by the isolated Alpha gate |
| Retained APK data across replay-ledger rebuild and revision-epoch rotation | Gateway session inventory must survive the rebuild | Enforced: an offline durable prompt, background delivery, notification, the next prompt, Agent invocation, and browser/APK convergence must all complete exactly once without reinstalling or repairing the APK |
| APK cover-install over a legacy encrypted submitted command | Not applicable | Enforced: ambiguous command is quarantined without replay, Gateway sequence is reconciled, new create/delete succeeds, and migration runs once across restart |
| Stale cross-device command review, discard, and immediate retry | Not yet enforced | Enforced by the isolated Alpha gate |
| Android foreground-service and completion notifications | Not applicable | Enforced by the isolated Alpha gate |
| Privacy bind, exact review, deny, sanitize, restore, fail-closed, and encrypted local state | Enforced on two browsers | Enforced by the isolated Alpha gate, including process restart |

An unimplemented cell is not implicitly passed. Web local business E2E may be
green while the overall release acceptance remains incomplete. The Alpha gate
uses an application-id-suffixed APK which can coexist with the normal APK. Its
native bridge accepts only the compiled loopback origin and reaches disposable
PWA and Synapse fixtures through `adb reverse`; it never reuses a person's
paired account. A distributable APK still has to pass the installed release
runner against the newly deployed production components.
