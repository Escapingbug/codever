# Client business-flow test contract

The Client is considered usable only when these user journeys pass. Unit tests for
schemas, stores, and renderers support this contract but do not replace it.

## Test layers

1. **Scripted Agent** — a deterministic `AgentProvider` replays ACP-like text
   deltas, tools, decisions, files, failures, and completion timing.
2. **Gateway journey** — the real Gateway runtime, event journal, adapters, and
   attachment store consume the scripted Agent and produce wire events.
3. **Client journey** — real Vue views, router, timeline, Markdown renderer, and
   cache run against a controllable Relay API. Child UI is not stubbed.
4. **Transport journey** — durable command/event delivery is tested across
   disconnect, replay, duplicate delivery, and acknowledgement boundaries.

Every production bug in a journey below must first gain a regression assertion at
the highest practical layer.

## Core journeys

| ID | Journey | Required assertions |
| --- | --- | --- |
| C01 | Restore paired Client | Cached workspace appears before network refresh; Relay and Gateway status are distinct. |
| C02 | Browse projects and tasks | Cached projects/tasks remain openable while inventory and provider discovery are pending or fail. |
| C03 | Open a Session | Recent cached messages render immediately; remote history merges without replacing visible cached content. |
| C04 | Send a message | Composer clears and a persistent user bubble appears in the same UI tick; the authoritative event reconciles it exactly once. |
| C05 | Stream an Agent turn | Live deltas update one working response; tools/decisions render semantically; finish changes state without waiting for a manual refresh. |
| C06 | Leave and reopen | Persisted history renders as a completed snapshot, never as newly typed live output; no duplicate messages appear. |
| C07 | Disconnect and recover | Cached Session stays readable; input reflects Relay + Gateway writability; reconnect catches up from the last durable sequence. |
| C08 | Load earlier history | Local cache is consumed first, then Gateway pages; the first visible message keeps its pixel offset. |
| C09 | Change Session behavior | Model, reasoning, mode, and permission controls remain available beside the composer and reconcile with Gateway settings. |
| C10 | Resolve decisions and cancel | A decision click does not open the inspector; cancel/finish transitions are visible and idempotent. |
| C11 | Upload and reuse files | Progress, retry, attachment bubble, Relay persistence, reuse, and cleanup are visible without blocking text history. |
| C12 | Download an Agent file | A local Project file link invokes authenticated Gateway export, appears in Session files, and downloads bytes; it never enters app routing. |
| C13 | Archive and resume | Archive removes a task from Recent, Restore returns it, and opening history alone does not mark it active. |

## Scripted Agent scenarios

The shared fixture must support these primitives without timers hidden inside the
test:

- emit a single event;
- pause until the test releases a gate;
- replay a provider-owned history snapshot;
- emit text in multiple ACP-style chunks;
- emit tool start/update/completion;
- request a decision and await its answer;
- finish, fail, or remain active until cancellation.

This lets a test assert intermediate UI state before allowing the next provider
event, which is essential for catching missing optimistic bubbles and delayed live
updates.

## Liveness and backpressure invariants

Successful final output is not enough. The following properties must hold while a
turn is still running or the transport remains continuously backlogged:

- accepting `session.message` must release the Gateway command consumer before the
  provider turn completes;
- cancel and decision responses must reach the active turn without waiting behind
  that turn, and one Session must not block commands for another Session;
- repeated ACP snapshots for one logical tool call must produce a bounded number of
  durable semantic events;
- durable replay must publish bounded batches even when the broker's pending count
  never reaches zero;
- Gateway restart must reconcile transient `querying` and `canceling` metadata;
- cached UI must remain readable and interactive while refresh and replay continue.

Tests for these rules need controllable infinite/paused streams and sustained
backlogs. Small finite fixtures that always complete cannot establish liveness.
