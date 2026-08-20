# Cross-version state upgrades

Codever treats an application update as a state transition, not as a fresh
start. This applies to online PWA updates, Android cover installs, Gateway
releases, and future desktop clients.

## State classes

Every persistent store must be registered as exactly one class:

| Class | Examples | Version change policy |
| --- | --- | --- |
| Security-critical | device identity, trust, replay ledger, Matrix login | Run every explicit `N -> N+1` migration. Preserve and enter repair if a step or validation is unavailable. Never delete automatically. |
| Durable command | native command outbox, unfinished pairing transaction | Run every explicit idempotent migration. Quarantine an ambiguous command only when its owning protocol defines a non-replayable tombstone. Never manufacture or resend a replacement command. |
| Rebuildable projection | conversation history cache, event cursor, Matrix sync projection | Reset only this projection when its schema changes or validation fails, then rebuild it from authenticated Matrix state/timeline. |
| Ephemeral UI | selected session, disclosure/read preferences | Reset the affected preference when incompatible. It must never block connection or execution. |

The state class itself is durable metadata. Changing a store from one class to
another requires a manifest migration and review; it must not happen merely by
editing the current catalog entry.

## Upgrade transaction

Before any business UI, Matrix connection, native bridge subscription, or
Gateway command processing starts, the owning runtime performs:

1. Read the upgrade manifest and reject a manifest from a newer incompatible
   runtime rather than attempting a downgrade.
2. Write a `running` journal containing the source version of every store.
3. For each store, write the active `N -> N+1` step, run its idempotent
   migration, validate the result, and atomically checkpoint the new version.
4. Reset only incompatible rebuildable/ephemeral state.
5. Reconcile durable commands with authoritative Gateway state and reconstruct
   projections from Matrix.
6. Write `complete` and unlock the runtime.

If the process stops after a store write but before its checkpoint, the active
adjacent step is replayed. Therefore every migration must accept both its exact
source representation and the already-migrated result produced by a previous
interrupted attempt.

Web localStorage and IndexedDB have separate journals because their atomicity
boundaries differ. Android keeps one journal beside the encrypted native
stores and another beside the Matrix-account stores. Gateway JSON/WAL files
carry their own schema version and use the same adjacent-migration rule.

## Version boundaries

The following versions are independent and must not be inferred from a build
number:

- PWA local-storage manifest and each local store;
- PWA IndexedDB manifest and each database;
- Android native manifest and each encrypted store;
- Android Matrix-account manifest and each account store;
- Gateway runtime/outbox/replay file schemas;
- Matrix application protocol (`MATRIX_NATIVE_PROTOCOL_VERSION`);
- Web/native bridge protocol (`NATIVE_BRIDGE_PROTOCOL_VERSION`).

A build ID is diagnostic metadata. Store versions decide migration; protocol
versions decide whether two concurrently running components can communicate.
Native bridge versions are negotiated. Matrix application events fail closed
when their authenticated version is unsupported; a storage migration must not
silently reinterpret a different wire protocol.

## Release rule

For every release that changes persistent state:

1. Increase only the affected store version.
2. Register and test every adjacent migration from the previous released
   version. Skipping directly from `N` to `N+2` is invalid.
3. Keep the previous release fixture. Do not rewrite it to resemble the new
   schema.
4. Prove: normal upgrade, process death during every new step, restart/resume,
   rollback refusal for security/durable state, projection rebuild, and normal
   create/prompt/history/delete business flows after upgrade.
5. Android validation must use `adb install -r` so application data, Keystore
   keys, Matrix login, and outboxes actually survive the update.
6. A migration is not accepted if only codec unit tests pass. The Web live E2E
   and Android Alpha E2E must finish business commands after the upgraded state
   reaches `complete`.

Adding a new persistent key/database without adding it to the owning catalog is
a release-blocking defect.

The fixture represents an actually shipped release. After a release it is
immutable: the next release adds a new fixture instead of editing the old one.
CI compares every retained fixture with the current catalogs, so an application
that skips a migration from any supported installed version cannot ship.

## Corruption and rollback

The manifest is not permission to trust source data. Stores are validated on
every startup even when the build ID and recorded schemas are unchanged. A
valid completed journal therefore cannot hide a subsequently damaged trust,
identity, replay, or command store.

An unreadable journal means the source versions are unknown. Security-critical
and durable-command stores are preserved and the runtime remains repair-only;
they are never relabelled as the current schema. If no protected state exists,
only rebuildable projections and ephemeral UI are reset and a new baseline is
created. Android `AtomicFile` recovery is attempted first; if both journal
copies are unreadable, startup fails closed and diagnostics identify the
upgrade journal rather than deleting encrypted stores.

Installing an older PWA/APK/Gateway over newer protected state is also a repair
condition, not a reverse migration. Explicit reverse migrations may be added
later, but an ordinary forward migration must never be run backwards.
