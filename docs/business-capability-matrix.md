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
  Relay API simulation and checks interaction, layout, and rendering behavior.
- **Durable transport**: NATS/JetStream tests verify idempotency, cursor catch-up,
  ordering, reconnect, and liveness separately from Provider output.
- **Live canary**: the opt-in real Codex journey validates assumptions that a
  recording cannot, then any discovered failure becomes a replay fixture.
- **Android device**: packaging, WebView lifecycle, secure storage, pairing, and
  foreground/background behavior require emulator or physical-device coverage.

## Capability matrix

| ID | User journey | ACP replay | Client UI | Durable transport | Live/Android | Current status |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | Pair Client with Relay | N/A | partial | secure-channel unit | live Node; Android failing | Partial |
| C02 | Pair and list multiple Gateways | N/A | automated | covered components | manual | Covered deterministically |
| C03 | Create/list Project using Gateway-native paths | N/A | automated (Windows) | command integration | manual | Covered deterministically |
| C04 | Create Session and send first task | automated | automated | automated | live Codex | Covered |
| C05 | Stream text/tool output and finish exactly once | automated | automated | automated | live Codex | Covered |
| C06 | Open cached history without replay animation | N/A | automated | event replay unit | live manual | Covered |
| C07 | Disconnect, read cache, reconnect, catch up by cursor | automated | automated | automated | live Codex | Covered |
| C08 | Stop a running tool and continue the same Session | automated | automated | worker liveness | live Codex | Covered |
| C09 | Change model/mode/reasoning/permission policy | model path automated | automated | command integration | manual | Partial |
| C10 | Resolve permission/decision without inspector collision | automated | automated | command integration | manual | Covered |
| C11 | Attach/upload/send/delete Session files | provider input unit | automated | object-store unit | manual large-file canary | Covered deterministically |
| C12 | Open an Agent-generated file link in the current Project | N/A | automated | attachment export unit | manual | Covered |
| C13 | Archive/restore Session without page-view activation | automated | automated | command integration | manual | Covered |
| C14 | Browse/attach an inactive Provider-native Session | automated bridge journey | automated | command integration | manual | Covered deterministically |
| C15 | Incrementally load old history without moving scroll anchor | N/A | automated | pagination unit | manual | Covered deterministically |
| C16 | Gateway restart during/after a turn and continue | automated graceful restart | not complete | crash reconciliation unit | live plan only | Partial |
| C17 | Relay restart, duplicate delivery, redelivery, and backlog | N/A | not complete | component tests | fault injection missing | Partial |
| C18 | Provider error, unavailable Provider, retry, and recovery | fixture support ready | partial | response tests | matrix missing | Partial |
| C19 | Branch/fork/edit/retry Provider history | unsupported | unsupported | unsupported | unsupported | Not implemented |
| C20 | Android install, pairing, background/resume, network switch | N/A | viewport only | N/A | pairing currently fails | Open defect |

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

## Next coverage tranche

The next highest-risk journeys are C20 Android pairing/lifecycle, C11 complete
attachment flow, C15 pagination/scroll anchoring in Playwright, and C16/C17
Gateway plus Relay restart fault injection. These are not marked covered merely
because their individual components have unit tests.
