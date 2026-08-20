import assert from "node:assert/strict";
import test from "node:test";
import {
  PWA_INDEXED_DB_MANIFEST_STORAGE_KEY,
  PwaIndexedDbUpgradeBlockedError,
  resetBlockedPwaIndexedDb,
  runPwaIndexedDbUpgrade,
  type PwaIndexedDbCatalogEntry,
} from "../app/indexedDbUpgrade.ts";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  failCompletedManifestOnce = false;
  failStoreCheckpointOnce = false;
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) {
    if (
      this.failCompletedManifestOnce &&
      key === PWA_INDEXED_DB_MANIFEST_STORAGE_KEY &&
      value.includes('"phase":"complete"')
    ) {
      this.failCompletedManifestOnce = false;
      throw new Error("simulated browser termination");
    }
    if (
      this.failStoreCheckpointOnce &&
      key === PWA_INDEXED_DB_MANIFEST_STORAGE_KEY &&
      value.includes('"phase":"running"') &&
      value.includes('"schemaVersion":2') &&
      value.includes('"activeMigration":null')
    ) {
      this.failStoreCheckpointOnce = false;
      throw new Error("simulated browser termination after database write");
    }
    this.values.set(key, value);
  }
}

const unusedFactory = {} as IDBFactory;

test("future IndexedDB security schemas run every adjacent migration", async () => {
  const storage = new MemoryStorage();
  let databaseVersion = 1;
  const v1 = catalog("security-critical", 1);
  await runPwaIndexedDbUpgrade(storage, unusedFactory, 1_000, [v1]);
  const steps: string[] = [];
  const v3: PwaIndexedDbCatalogEntry = {
    ...v1,
    schemaVersion: 3,
    migrationFromVersions: new Set([1, 2]),
    migrate: async (from, to) => {
      assert.equal(databaseVersion, from);
      databaseVersion = to;
      steps.push(`${from}-${to}`);
    },
    validate: async () => assert.equal(databaseVersion, 3),
  };

  await runPwaIndexedDbUpgrade(storage, unusedFactory, 2_000, [v3]);

  assert.deepEqual(steps, ["1-2", "2-3"]);
  const manifest = JSON.parse(storage.getItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY)!);
  assert.equal(manifest.phase, "complete");
  assert.equal(manifest.stores[0].schemaVersion, 3);
});

test("future IndexedDB security bump without a step blocks without reset", async () => {
  const storage = new MemoryStorage();
  let reset = false;
  const v1 = { ...catalog("security-critical", 1), reset: async () => { reset = true; } };
  await runPwaIndexedDbUpgrade(storage, unusedFactory, 1_000, [v1]);

  await assert.rejects(
    runPwaIndexedDbUpgrade(storage, unusedFactory, 2_000, [{ ...v1, schemaVersion: 2 }]),
    PwaIndexedDbUpgradeBlockedError,
  );
  assert.equal(reset, false);
});

test("future IndexedDB projection bump resets only its database", async () => {
  const storage = new MemoryStorage();
  let resets = 0;
  const v1 = {
    ...catalog("rebuildable-projection", 1),
    reset: async () => { resets += 1; },
  };
  await runPwaIndexedDbUpgrade(storage, unusedFactory, 1_000, [v1]);
  await runPwaIndexedDbUpgrade(storage, unusedFactory, 2_000, [
    { ...v1, schemaVersion: 2 },
  ]);
  assert.equal(resets, 1);
});

test("interrupted IndexedDB migration replays its idempotent active step", async () => {
  const storage = new MemoryStorage();
  const v1 = catalog("security-critical", 1);
  await runPwaIndexedDbUpgrade(storage, unusedFactory, 1_000, [v1]);
  let databaseVersion = 1;
  let calls = 0;
  const v2: PwaIndexedDbCatalogEntry = {
    ...v1,
    schemaVersion: 2,
    migrationFromVersions: new Set([1]),
    migrate: async (_from, to) => {
      calls += 1;
      databaseVersion = Math.max(databaseVersion, to);
    },
    validate: async () => assert.equal(databaseVersion, 2),
  };
  storage.failStoreCheckpointOnce = true;
  await assert.rejects(
    runPwaIndexedDbUpgrade(storage, unusedFactory, 2_000, [v2]),
    (error: unknown) =>
      error instanceof PwaIndexedDbUpgradeBlockedError &&
      error.cause instanceof Error &&
      error.cause.message === "simulated browser termination after database write",
  );
  await runPwaIndexedDbUpgrade(storage, unusedFactory, 3_000, [v2]);
  assert.equal(calls, 2);
  assert.equal(databaseVersion, 2);
});

test("a completed IndexedDB manifest never bypasses database validation", async () => {
  const storage = new MemoryStorage();
  let valid = true;
  const security = {
    ...catalog("security-critical", 1),
    validate: async () => {
      if (!valid) throw new Error("damaged identity database");
    },
  };
  await runPwaIndexedDbUpgrade(storage, unusedFactory, 1_000, [security]);
  valid = false;

  await assert.rejects(
    runPwaIndexedDbUpgrade(storage, unusedFactory, 2_000, [security]),
    (error: unknown) =>
      error instanceof PwaIndexedDbUpgradeBlockedError &&
      error.blockedKeys.includes("fixture-db"),
  );
});

test("a damaged IndexedDB journal preserves databases with protected state", async () => {
  const storage = new MemoryStorage();
  storage.setItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY, "truncated");
  let reset = false;
  const security = {
    ...catalog("security-critical", 1),
    reset: async () => { reset = true; },
  };

  await assert.rejects(
    runPwaIndexedDbUpgrade(storage, unusedFactory, 1_000, [security]),
    (error: unknown) =>
      error instanceof PwaIndexedDbUpgradeBlockedError &&
      error.blockedKeys.includes("fixture-db"),
  );
  assert.equal(reset, false);
  assert.equal(storage.getItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY), "truncated");
});

test("explicit database repair clears unknown-version projections too", async () => {
  const storage = new MemoryStorage();
  storage.setItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY, "truncated");
  let securityResets = 0;
  let projectionResets = 0;
  const security = {
    ...catalog("security-critical", 1),
    reset: async () => { securityResets += 1; },
  };
  const projection = {
    ...catalog("rebuildable-projection", 1),
    id: "projection",
    databaseName: "projection-db",
    reset: async () => { projectionResets += 1; },
  };

  await resetBlockedPwaIndexedDb(
    storage,
    unusedFactory,
    [],
    [security, projection],
  );

  assert.equal(securityResets, 0);
  assert.equal(projectionResets, 1);
  assert.equal(storage.getItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY), null);
});

test("a damaged projection-only IndexedDB journal resets and resumes", async () => {
  const storage = new MemoryStorage();
  storage.setItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY, "truncated");
  let resets = 0;
  const projection = {
    ...catalog("rebuildable-projection", 1),
    reset: async () => { resets += 1; },
  };

  await runPwaIndexedDbUpgrade(storage, unusedFactory, 1_000, [projection]);

  assert.equal(resets, 1);
  assert.equal(
    JSON.parse(storage.getItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY)!).phase,
    "complete",
  );
});

function catalog(
  stateClass: PwaIndexedDbCatalogEntry["stateClass"],
  schemaVersion: number,
): PwaIndexedDbCatalogEntry {
  return {
    id: "fixture",
    databaseName: "fixture-db",
    stateClass,
    schemaVersion,
    legacySchemaVersion: 1,
    validate: async () => {},
    reset: async () => {},
  };
}
