# Codever business journey contract

The release E2E suite must prove complete user journeys, not only isolated screens.

## J01: first client to first agent reply

1. A fresh client configures a server and signs in.
2. An encrypted Gateway announcement appears as a Computer candidate.
3. The client starts SAS verification and both sides display the same emoji.
4. Client confirmation alone keeps the Computer in `verification-required` and sends no Gateway command.
5. Gateway confirmation advances the Matrix flow to `done`.
6. Only after `done` may the client request execution-root authorization.
7. The authorized client can list or create projects.
8. The user creates a task, sees their message immediately, and receives the replayed agent result.
9. Revisiting the task renders cached history without replay animation.

## J02: verification failure and recovery

- A mismatch or remote cancellation never marks either device trusted.
- A timeout sends no project or execution command and offers a fresh verification attempt.
- A completed bilateral verification survives navigation and refresh.

## J02a: later client enrollment

1. An authorized client opens Settings and starts SAS verification for a new signed-in client.
2. Both clients compare and confirm the same ordered emoji without opening the Gateway.
3. The new client requests access to a Gateway.
4. The authorized client approves the request with its existing COSE execution root.
5. The Gateway records the new Matrix Device ID and execution public key, and the new client can control it.

## J03: interruption and durable recovery

- Cached projects, tasks, and history remain readable during Matrix interruption.
- Pending user input is reconciled exactly once after reconnect.
- Missing live deltas are recovered from the Gateway journal.

## Required test boundaries

- Browser E2E uses a stateful backend model with separate client-confirmed and Gateway-confirmed states.
- Protocol tests prove unverified devices cannot receive inventory or execute commands.
- Native transport tests prove local device trust is persisted only after bilateral SAS completion.
- UI assertions prove setup status and available actions; tests must not mutate directly to a later state without asserting the blocked intermediate state.
