import assert from "node:assert/strict";
import test from "node:test";
import { CODEVER_BUILD_VERSION } from "../app/buildInfo.ts";
import {
  PWA_STATE_CATALOG,
  PWA_STATE_MANIFEST_STORAGE_KEY,
  PwaStateUpgradeBlockedError,
  resetBlockedPwaConnection,
  runPwaStateUpgrade,
  type PwaStateCatalogEntry,
} from "../app/stateUpgrade.ts";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  failCompletedManifestOnce = false;

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (
      this.failCompletedManifestOnce &&
      key === PWA_STATE_MANIFEST_STORAGE_KEY &&
      value.includes('"phase":"complete"')
    ) {
      this.failCompletedManifestOnce = false;
      throw new Error("simulated process death before commit");
    }
    this.values.set(key, value);
  }
}

test("first coordinated upgrade preserves security state and invalidates only rebuildable state", () => {
  const storage = new MemoryStorage();
  storage.setItem("codever.matrix.connection.v1", '{"homeserver":"https://matrix.example"}');
  storage.setItem("codever.pairing.trust.v1", '{"version":1}');
  storage.setItem("codever.native.cursor.v1.device", "c1.stale");
  storage.setItem("codever:pending-session-create:v1", '{"version":0}');
  storage.setItem("codever.ui.project-disclosure.v1", '{"version":99}');

  const result = runPwaStateUpgrade(storage, 1_000);

  assert.equal(result.migratedFrom, 0);
  assert.equal(storage.getItem("codever.matrix.connection.v1"), '{"homeserver":"https://matrix.example"}');
  assert.equal(storage.getItem("codever.pairing.trust.v1"), '{"version":1}');
  assert.equal(storage.getItem("codever.native.cursor.v1.device"), "c1.stale");
  assert.equal(storage.getItem("codever:pending-session-create:v1"), null);
  assert.equal(storage.getItem("codever.ui.project-disclosure.v1"), null);
  const manifest = JSON.parse(storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY)!);
  assert.equal(manifest.phase, "complete");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.appBuild, CODEVER_BUILD_VERSION);
  assert.deepEqual(manifest.invalidated, [
    "pending-session-create-projection",
    "project-disclosure",
  ]);
});

test("an interrupted upgrade resumes idempotently from its running journal", () => {
  const storage = new MemoryStorage();
  storage.setItem("codever.ui.project-disclosure.v1", '{"version":99}');
  storage.failCompletedManifestOnce = true;
  assert.throws(() => runPwaStateUpgrade(storage, 1_000), /simulated process death/);
  assert.equal(
    JSON.parse(storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY)!).phase,
    "running",
  );

  const resumed = runPwaStateUpgrade(storage, 2_000);
  assert.equal(resumed.migratedFrom, null);
  assert.equal(storage.getItem("codever.ui.project-disclosure.v1"), null);
  const manifest = JSON.parse(storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY)!);
  assert.equal(manifest.phase, "complete");
  assert.equal(manifest.startedAt, 1_000);
});

test("a build change without a storage-schema change preserves valid projections", () => {
  const storage = new MemoryStorage();
  runPwaStateUpgrade(storage, 1_000);
  const manifest = JSON.parse(storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY)!);
  storage.setItem(
    PWA_STATE_MANIFEST_STORAGE_KEY,
    JSON.stringify({ ...manifest, appBuild: "previous-build" }),
  );
  storage.setItem("codever.native.cursor.v1.device", "c1.current");

  const result = runPwaStateUpgrade(storage, 2_000);
  assert.equal(result.migratedFrom, null);
  assert.equal(storage.getItem("codever.native.cursor.v1.device"), "c1.current");
});

test("malformed security state is preserved and requires an explicit local reset", () => {
  const storage = new MemoryStorage();
  storage.setItem("codever.pairing.trust.v1", "not-json");

  let blocked: PwaStateUpgradeBlockedError | null = null;
  try {
    runPwaStateUpgrade(storage, 1_000);
  } catch (error) {
    assert.ok(error instanceof PwaStateUpgradeBlockedError);
    blocked = error;
  }
  if (!blocked) throw new Error("Expected the upgrade to be blocked.");
  assert.deepEqual(blocked.blockedKeys, ["codever.pairing.trust.v1"]);
  assert.equal(storage.getItem("codever.pairing.trust.v1"), "not-json");

  resetBlockedPwaConnection(storage, blocked.blockedKeys);
  assert.equal(storage.getItem("codever.pairing.trust.v1"), null);
  assert.equal(storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY), null);
});

test("a completed manifest never bypasses validation of protected state", () => {
  const storage = new MemoryStorage();
  storage.setItem("codever.pairing.trust.v1", '{"version":1}');
  runPwaStateUpgrade(storage, 1_000);
  storage.setItem("codever.pairing.trust.v1", "damaged-after-upgrade");

  assert.throws(
    () => runPwaStateUpgrade(storage, 2_000),
    (error: unknown) =>
      error instanceof PwaStateUpgradeBlockedError &&
      error.blockedKeys.includes("codever.pairing.trust.v1"),
  );
  assert.equal(storage.getItem("codever.pairing.trust.v1"), "damaged-after-upgrade");
});

test("a damaged journal preserves protected state and requires explicit repair", () => {
  const storage = new MemoryStorage();
  storage.setItem("codever.pairing.trust.v1", '{"version":1,"key":"keep"}');
  storage.setItem(PWA_STATE_MANIFEST_STORAGE_KEY, "truncated");

  assert.throws(
    () => runPwaStateUpgrade(storage, 1_000),
    (error: unknown) =>
      error instanceof PwaStateUpgradeBlockedError &&
      error.blockedKeys.includes("codever.pairing.trust.v1"),
  );
  assert.equal(
    storage.getItem("codever.pairing.trust.v1"),
    '{"version":1,"key":"keep"}',
  );
  assert.equal(storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY), "truncated");

  resetBlockedPwaConnection(storage, ["codever.pairing.trust.v1"]);
  assert.equal(storage.getItem("codever.pairing.trust.v1"), null);
  assert.equal(storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY), null);
});

test("explicit repair also clears projections whose source version became unknowable", () => {
  const storage = new MemoryStorage();
  storage.setItem("fixture.security", "keep-until-confirmed");
  storage.setItem("fixture.projection", "unknown-schema");
  const catalog: PwaStateCatalogEntry[] = [
    {
      id: "security",
      key: "fixture.security",
      prefix: false,
      stateClass: "security-critical",
      schemaVersion: 1,
      legacySchemaVersion: 1,
    },
    {
      id: "projection",
      key: "fixture.projection",
      prefix: false,
      stateClass: "rebuildable-projection",
      schemaVersion: 1,
      legacySchemaVersion: 1,
    },
  ];

  resetBlockedPwaConnection(storage, ["fixture.security"], catalog);

  assert.equal(storage.getItem("fixture.security"), null);
  assert.equal(storage.getItem("fixture.projection"), null);
});

test("a damaged journal with projection-only state rebuilds without blocking", () => {
  const storage = new MemoryStorage();
  storage.setItem("codever.native.cursor.v1.device", "unknown-version-cursor");
  storage.setItem(PWA_STATE_MANIFEST_STORAGE_KEY, "truncated");

  runPwaStateUpgrade(storage, 1_000);

  assert.equal(storage.getItem("codever.native.cursor.v1.device"), null);
  assert.equal(
    JSON.parse(storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY)!).phase,
    "complete",
  );
});

test("future browser state fails closed instead of being downgraded", () => {
  const storage = new MemoryStorage();
  storage.setItem(PWA_STATE_MANIFEST_STORAGE_KEY, JSON.stringify({ version: 99 }));
  assert.throws(
    () => runPwaStateUpgrade(storage, 1_000),
    (error: unknown) =>
      error instanceof PwaStateUpgradeBlockedError &&
      error.message.includes("cannot safely downgrade"),
  );
});

test("a future security-store bump must run every registered adjacent migration", () => {
  const storage = new MemoryStorage();
  storage.setItem("fixture.security", JSON.stringify({ version: 1, identity: "kept" }));
  const versionOne: PwaStateCatalogEntry[] = [{
    id: "fixture-security",
    key: "fixture.security",
    prefix: false,
    stateClass: "security-critical",
    schemaVersion: 1,
    legacySchemaVersion: 1,
  }];
  runPwaStateUpgrade(storage, 1_000, versionOne);

  const versionThree: PwaStateCatalogEntry[] = [{
    ...versionOne[0]!,
    schemaVersion: 3,
    migrations: {
      1: ({ storage: target }) => {
        const value = JSON.parse(target.getItem("fixture.security")!);
        target.setItem("fixture.security", JSON.stringify({ ...value, version: 2, migrated2: true }));
      },
      2: ({ storage: target }) => {
        const value = JSON.parse(target.getItem("fixture.security")!);
        target.setItem("fixture.security", JSON.stringify({ ...value, version: 3, migrated3: true }));
      },
    },
    validate: target => JSON.parse(target.getItem("fixture.security")!).version === 3,
  }];
  runPwaStateUpgrade(storage, 2_000, versionThree);

  assert.deepEqual(JSON.parse(storage.getItem("fixture.security")!), {
    version: 3,
    identity: "kept",
    migrated2: true,
    migrated3: true,
  });
  assert.deepEqual(
    JSON.parse(storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY)!).stores,
    [{ id: "fixture-security", stateClass: "security-critical", schemaVersion: 3 }],
  );
});

test("a future durable schema bump without a registered step blocks and preserves data", () => {
  const storage = new MemoryStorage();
  storage.setItem("fixture.command", '{"version":1,"commandId":"keep"}');
  const versionOne: PwaStateCatalogEntry[] = [{
    id: "fixture-command",
    key: "fixture.command",
    prefix: false,
    stateClass: "durable-command",
    schemaVersion: 1,
    legacySchemaVersion: 1,
  }];
  runPwaStateUpgrade(storage, 1_000, versionOne);
  assert.throws(
    () => runPwaStateUpgrade(storage, 2_000, [{ ...versionOne[0]!, schemaVersion: 2 }]),
    PwaStateUpgradeBlockedError,
  );
  assert.equal(
    storage.getItem("fixture.command"),
    '{"version":1,"commandId":"keep"}',
  );
});

test("a future projection bump invalidates only that projection", () => {
  const storage = new MemoryStorage();
  const cursor = PWA_STATE_CATALOG.find(entry => entry.id === "native-event-cursor")!;
  storage.setItem("codever.native.cursor.v1.device", "old-cursor");
  runPwaStateUpgrade(storage, 1_000, [cursor]);
  runPwaStateUpgrade(storage, 2_000, [{ ...cursor, schemaVersion: 2 }]);
  assert.equal(storage.getItem("codever.native.cursor.v1.device"), null);
});
