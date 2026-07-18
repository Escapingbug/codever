# Real development end-to-end test

This suite complements deterministic unit and UI tests by driving a real Client
identity through Relay, NATS JetStream, Gateway, and the real Codex ACP provider.
It uses a disposable Project and a deliberately tiny file task so failures test
Codever rather than the complexity of the requested implementation.

## Required journey

| Phase | User action | Pass condition |
| --- | --- | --- |
| Bootstrap | Pair a fresh Client and Gateway, register a disposable Project, create a Codex Session | Every command receives a durable response and inventory contains the new resources. |
| Develop | Ask Codex to create a two-line artifact and verify it | User event appears, output streams, turn finishes, and the expected file exists. |
| Interrupt | Ask Codex to run a long command, then press Stop | Stop is acknowledged within five seconds and the turn reaches `cancelled`; no refresh is required. |
| Background | Suspend the Client while a command completes | UI becomes reconnecting; resume recreates all consumers and receives the pending response. |
| Catch up | Resume with thousands of pending events | Responses and Stop remain usable while event history catches up in bounded batches. |
| Adjust | Continue the same Provider Session with a changed requirement | The existing Session is reused and the artifact reflects the new requirement. |
| Navigate | Leave and reopen during and after output | Cached content is immediate, completed text does not animate again, and live output resumes once. |
| Restart | Restart Gateway between turns | Transient state reconciles, the Provider Session ID is retained, and the next turn succeeds. |

## Observability contract

Each run records four independent facts: Client-visible state, JetStream consumer
pending/ack counts, Gateway journal state, and resulting files. A phase does not
pass merely because one layer eventually reports success.

The live suite is opt-in because it consumes a real Codex turn and requires
short-lived Relay and Gateway pairing codes. Deterministic regressions extracted
from every live failure remain in the normal test suite.
