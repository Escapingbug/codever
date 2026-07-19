# Business capability end-to-end matrix

This matrix treats Codever as a remote development product, not as a collection
of transport endpoints. A capability is complete only when its observable user
journey has a deterministic regression test. Real Codex runs discover behavior;
sanitized ACP transcripts preserve it for normal CI.

## Test layers

- **ACP replay**: raw `session/update`, prompt completion, permission requests,
  and cancellation are replayed at the `AcpClientManager` boundary. The real
  `AcpProvider`, Gateway runtime, metadata repository, and event store execute.
- **Client UI**: Playwright drives the mobile viewport against a deterministic
  Matrix API simulation and checks interaction, layout, and rendering behavior.
- **Durable transport**: Matrix timeline/sync tests verify transaction
  idempotency, backlog catch-up, ordering, reconnect, E2EE trust and liveness
  separately from Provider output.
- **Live canary**: the opt-in real Codex journey validates assumptions that a
  recording cannot, then any discovered failure becomes a replay fixture.
- **Android device**: packaging, WebView lifecycle, secure storage, pairing, and
  foreground/background behavior require emulator or physical-device coverage.
- **Windows native**: a dedicated Tauri build is driven through its embedded W3C
  WebDriver. It uses an isolated application identifier and verifies WebView2,
  native window behavior, runtime-error containment, IndexedDB/localStorage
  recovery, and real Windows Credential Manager persistence.
- **Native event boundary**: Vitest drives the actual Tauri event-listener API
  contract and verifies that Matrix timeline events, sync/session status, and
  malformed native payloads cannot be confused with one another.

## Capability matrix

| ID | User journey | ACP replay | Client UI | Durable transport | Live/Android | Current status |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | Log in and verify a Matrix client device | N/A | automated settings flow | official SDK SAS state machine | Android recheck required | Partial |
| C02 | Verify and list multiple Gateways | N/A | automated | Matrix SAS plus independent COSE authorization | real SAS smoke passed | Covered deterministically |
| C03 | Create/list Project using Gateway-native paths | N/A | automated (Windows) | command integration | manual | Covered deterministically |
| C04 | Create Session and send first task | automated | automated | automated | live Codex | Covered |
| C05 | Stream text/tool output and finish exactly once | automated | automated | automated | live Codex | Covered |
| C06 | Open cached history without replay animation | N/A | automated | event replay unit | live manual | Covered |
| C07 | Disconnect, read cache, reconnect, catch up by cursor | automated | automated | automated | live Codex | Covered |
| C08 | Stop a running tool and continue the same Session | automated | automated | worker liveness | live Codex | Covered |
| C09 | Change model/mode/reasoning/permission policy | model path automated | automated | command integration | manual | Covered deterministically |
| C10 | Resolve permission/decision without inspector collision | automated | automated | command integration | manual | Covered |
| C11 | Attach/upload/send/delete Session files | provider input unit | automated | object-store unit | manual large-file canary | Covered deterministically |
| C12 | Open an Agent-generated file link in the current Project | N/A | automated | attachment export unit | manual | Covered |
| C13 | Archive/restore Session without page-view activation | automated | automated | command integration | manual | Covered |
| C14 | Browse/attach an inactive Provider-native Session | automated bridge journey | automated | command integration | manual | Covered deterministically |
| C15 | Incrementally load old history without moving scroll anchor | N/A | automated | pagination unit | manual | Covered deterministically |
| C16 | Gateway restart during/after a turn and continue | automated restart/resume | cached UI covered by C07 | pending/completed crash ledger tests | live plan only | Covered deterministically |
| C17 | Matrix sync restart, duplicate delivery, redelivery, and backlog | N/A | automated reconnect/backlog/dedup | transaction-ID convergence, replay guard, ordering | live process fault injection optional | Covered deterministically |
| C18 | Provider error, unavailable Provider, retry, and recovery | refusal/failure/retry fixture | automated | response tests | replayed in CI | Covered |
| C19 | Branch/fork/edit/retry Provider history | unsupported | unsupported | unsupported | unsupported | Not implemented |
| C20 | Android install, login, SAS, background/resume, network switch | N/A | viewport and lifecycle unit | Matrix token refresh and sync resume | physical-device recheck required | Partial |
| C21 | Windows native shell, credential restart, and core development journey | replay-backed mock | native WebView2 automated | offline recovery exercised | real Credential Manager and process restart | Covered deterministically |

## Required CI gates

1. Every production ACP behavior fix adds or updates a sanitized raw replay
   fixture and an assertion at the user-visible event boundary.
2. No journey may use arbitrary sleeps for ordering. Replay gates and observed
   durable cursors provide deterministic synchronization.
3. UI tests assert both immediate optimistic state and later authoritative
   reconciliation; final-state-only assertions are insufficient.
4. Cached and live paths are tested independently. Reopening cached history must
   never animate old output or wait for refresh before navigation.
5. Live Codex canaries remain opt-in, but their last successful transcript and
   artifact assertions are versioned and replayed on every normal test run.

Run the deterministic business gate with `pnpm test:business-e2e`. It executes
the ACP/Gateway journeys, Web type checking and unit tests, and all mobile
Playwright journeys using fail-fast command chaining.

On Windows, run `pnpm test:release-e2e`. This runs the portable business gate,
then builds a feature-gated native test binary and drives nine core journeys in
the real WebView2 process. The narrower `pnpm test:desktop-e2e` command runs only
the native portion. Native automation is kept
separate from the portable business gate because native compilation and window
automation require a Windows desktop session.

## ACP replay fixture contract

Fixtures under `test/fixtures/acp` preserve raw ACP `session/update` payloads,
prompt stop reasons, permission requests, and explicit synchronization gates.
They intentionally exclude credentials, absolute user paths, prompt secrets,
and timing delays. A fixture is matched against the exact user prompt so an
unintended journey change fails instead of silently replaying the wrong turn.

The replay boundary replaces only `AcpClientManager`; `AcpProvider`, ACP event
mapping, Gateway lifecycle, decision handling, metadata, and durable event
storage are production implementations. Consequently a fixture catches adapter
and business-state regressions that a final-text API mock cannot catch.

## Remaining coverage

C20 still needs a repeatable Android instrumentation lane that installs a build,
pairs against an ephemeral private Matrix server, backgrounds and resumes the
WebView, switches network state, and verifies sync catch-up. C01 remains partial until that lane
proves the complete first-device UI journey on Android. C19 is a product gap,
not a missing test: branch/fork/edit/retry must first be represented by Provider
capabilities and a stable cross-provider semantic model.

C21 proves the deterministic Windows shell contract, but signed installer
upgrade/uninstall retention and a live Matrix/Gateway process-kill canary remain
release engineering checks rather than normal deterministic tests. Linux and
macOS need their own native CI runners before their shells can inherit C21's
status.

Live Matrix/Gateway process-kill canaries remain useful environmental checks for
C16/C17, but deterministic CI already covers the observable recovery contract:
uncertain mutations are not repeated, completed commands replay after restart,
transient cache and acknowledgement failures request redelivery, duplicate
events converge by sequence, and cached conversations stay readable offline.
