# Client business-flow test contract

The client is usable only when these user journeys pass. Unit tests for schemas,
stores and renderers support this contract but do not replace it.

## Test layers

1. **ACP replay** — a deterministic provider replays text deltas, tools,
   decisions, files, failures and completion gates.
2. **Gateway journey** — the real Gateway runtime, event journal, adapters and
   attachment store consume the replay and produce semantic wire events.
3. **Client journey** — real Vue views, router, timeline, Markdown renderer and
   cache run against a controllable Matrix transport simulation.
4. **Transport journey** — the official Matrix SDK and COSE boundary are tested
   across sync restart, redelivery, duplicate events, expiry and replay.

Every production bug in a journey below must gain a regression assertion at the
highest practical layer.

## Core journeys

| ID | Journey | Required assertions |
| --- | --- | --- |
| C01 | Restore a logged-in client | Cached workspace appears before Matrix refresh; sync and Gateway status are not conflated. |
| C02 | Browse projects and tasks | Cached projects/tasks remain openable while inventory and provider discovery are pending or fail. |
| C03 | Open a Session | Recent cached messages render immediately; remote history merges without replacing visible cached content. |
| C04 | Send a message | Composer clears and a persistent user bubble appears in the same UI tick; the authoritative event reconciles it exactly once. |
| C05 | Stream an Agent turn | Live deltas update one working response; tools/decisions render semantically; finish changes state without manual refresh. |
| C06 | Leave and reopen | Persisted history renders as a completed snapshot, never as newly typed live output; no duplicate appears. |
| C07 | Disconnect and recover | Cached Session stays readable; input reflects Matrix sync plus Gateway writability; reconnect catches up automatically. |
| C08 | Load earlier history | Local cache is consumed first, then Gateway pages; the first visible message keeps its pixel offset. |
| C09 | Change Session behavior | Model, reasoning, mode and permission controls remain available beside the composer and reconcile with Gateway settings. |
| C10 | Resolve decisions and cancel | A decision click does not open the inspector; cancel/finish transitions are visible and idempotent. |
| C11 | Upload and reuse files | Progress, retry, attachment bubble, encrypted persistence, reuse and cleanup are visible without blocking text history. |
| C12 | Download an Agent file | A Project file link invokes authorized Gateway export, appears in Session files and downloads bytes without entering app routing. |
| C13 | Archive and resume | Archive removes a task from Recent, Restore returns it, and opening history alone does not mark it active. |

## ACP replay primitives

The shared fixture supports these operations without hidden timing sleeps:

- emit one event;
- pause until the test releases a gate;
- replay a provider-owned history snapshot;
- emit text in multiple ACP-style chunks;
- emit tool start/update/completion;
- request a decision and await its answer;
- finish, fail or remain active until cancellation.

This allows tests to assert intermediate UI state before releasing the next
provider event, which catches missing optimistic bubbles and delayed live updates.

## Liveness and backpressure invariants

Successful final output is insufficient. While a turn runs or synchronization
remains backlogged:

- accepting `session.message` releases command handling before the provider turn
  completes;
- cancel and decision responses reach the active turn without waiting behind it;
- one Session cannot block commands for another Session;
- repeated ACP snapshots for one tool call produce bounded semantic events;
- Matrix redelivery converges by transaction/event/request IDs;
- Gateway restart reconciles transient `querying` and `canceling` metadata;
- cached UI remains readable while refresh and replay continue.

Tests use controllable paused streams and sustained backlogs. Small fixtures that
always complete cannot establish liveness.
