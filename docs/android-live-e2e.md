# Android live end-to-end release gate

The Android release gate proves the installed APK against production protocol
implementations. Passing Playwright with a mobile viewport is not a substitute
for this gate.

## Required topology

```text
Android emulator APK
  -> Tauri Android commands and platform credential store
  -> real Matrix SDK crypto store
  -> disposable private Synapse account
  -> real encrypted control room
  -> real Windows Gateway Matrix device
  -> replay-backed ACP Provider
```

The test account, Matrix devices, control room and Project are unique per run.
The runner removes them after the run. Long-lived deployment credentials must
never be typed through coordinates or printed in UI hierarchy diagnostics.

## Release-blocking journey

1. Install the exact signed APK artifact into a clean emulator data directory.
2. Configure the server using only its domain and log in through the native
   credential store.
3. Start Gateway verification locally, request SAS from Android, advance both
   real Matrix state machines, compare the ordered emoji, and confirm both
   sides. A request that remains at `requested` or `ready` fails the build.
4. Approve the Android execution root through a real authorized Gateway path.
5. Discover exactly the expected Gateway. Stale smoke-test devices are not
   valid substitutes.
6. Create a Windows Project, create a Session, send one task, observe the
   optimistic user message, and receive replay-backed streaming Agent output.
7. Background and force-stop Android during a second turn. Restart it and
   prove that cached history is immediately visible and Matrix sync converges
   without duplicate execution or replay animation.
8. Stop a running turn, reopen it, archive and restore it, and upload/download
   one attachment.
9. Upgrade the APK in place and prove that Matrix credentials, execution keys,
   IndexedDB history and authorization survive.

## Fault matrix

The same vertical journey runs with one fault at each durable boundary:

- Matrix unavailable before send and after send;
- Gateway exits before accepting, after accepting and after persisting output;
- Android exits before and after its IndexedDB commit;
- duplicate and delayed Matrix timeline delivery;
- token refresh failure and recovery;
- revoked, malformed and replayed COSE authorization;
- unverified Matrix device attempting discovery and execution.

Every case has an observable terminal state. The test fails on an indefinite
`sending`, `querying`, `requested`, `ready`, or `command pending` state.

## Test-layer contract

- FakeTransport tests remain fast interaction tests; they cannot promote a
  build to Android-ready.
- Rust Matrix tests prove cryptographic and state-machine behavior in isolation.
- Windows WebDriver proves desktop native persistence.
- Only this installed-APK vertical journey can promote an Android artifact for
  user trial.

The current `test:android:live:login` runner covers steps 1-2. Steps 3-9 remain
release blockers until their real implementations and automation pass.
