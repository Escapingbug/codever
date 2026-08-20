import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PWA_INDEXED_DB_MANIFEST_MIGRATIONS,
  PWA_INDEXED_DB_MANIFEST_SCHEMA_VERSION,
  pwaIndexedDbCatalog,
} from "../app/indexedDbUpgrade.ts";
import {
  PWA_STATE_CATALOG,
  PWA_STATE_MANIFEST_MIGRATIONS,
  PWA_STATE_SCHEMA_VERSION,
  type PwaStateCatalogEntry,
} from "../app/stateUpgrade.ts";

type ReleasedEntry = {
  id: string;
  stateClass: PwaStateCatalogEntry["stateClass"];
  schemaVersion: number;
};

const fixture = JSON.parse(await readFile(
  fileURLToPath(new URL("./fixtures/released-state-catalog-v1.json", import.meta.url)),
  "utf8",
)) as {
  localStorageManifestVersion: number;
  indexedDbManifestVersion: number;
  localStorage: ReleasedEntry[];
  indexedDb: ReleasedEntry[];
};

test("the current PWA registers every migration from the released storage catalog", () => {
  assertManifestCoverage(
    fixture.localStorageManifestVersion,
    PWA_STATE_SCHEMA_VERSION,
    PWA_STATE_MANIFEST_MIGRATIONS,
    "localStorage manifest",
  );
  assertCoverage(
    fixture.localStorage,
    PWA_STATE_CATALOG.map(entry => ({
      ...entry,
      migrationFromVersions: new Set(
        Object.entries(entry.migrations ?? {})
          .filter(([, migration]) => typeof migration === "function")
          .map(([version]) => Number(version)),
      ),
    })),
  );
});

test("the current PWA registers every IndexedDB migration from the released catalog", () => {
  assertManifestCoverage(
    fixture.indexedDbManifestVersion,
    PWA_INDEXED_DB_MANIFEST_SCHEMA_VERSION,
    PWA_INDEXED_DB_MANIFEST_MIGRATIONS,
    "IndexedDB manifest",
  );
  const current = pwaIndexedDbCatalog({} as IDBFactory);
  assertCoverage(fixture.indexedDb, current);
});

function assertCoverage(
  released: readonly ReleasedEntry[],
  current: readonly (ReleasedEntry & { migrationFromVersions?: ReadonlySet<number> })[],
) {
  for (const previous of released) {
    const next = current.find(entry => entry.id === previous.id);
    assert.ok(next, `Released store ${previous.id} was removed without a retirement migration.`);
    assert.equal(
      next.stateClass,
      previous.stateClass,
      `Released store ${previous.id} changed safety class without a manifest migration.`,
    );
    assert.ok(
      next.schemaVersion >= previous.schemaVersion,
      `Released store ${previous.id} was downgraded.`,
    );
    if (
      previous.stateClass === "security-critical" ||
      previous.stateClass === "durable-command"
    ) {
      for (let version = previous.schemaVersion; version < next.schemaVersion; version += 1) {
        assert.ok(
          next.migrationFromVersions?.has(version),
          `Released store ${previous.id} has no ${version} -> ${version + 1} migration.`,
        );
      }
    }
  }
}

function assertManifestCoverage(
  releasedVersion: number,
  currentVersion: number,
  migrations: Readonly<Record<number, unknown>>,
  label: string,
) {
  assert.ok(currentVersion >= releasedVersion, `${label} was downgraded.`);
  for (let version = releasedVersion; version < currentVersion; version += 1) {
    assert.equal(
      typeof migrations[version],
      "function",
      `${label} has no ${version} -> ${version + 1} migration.`,
    );
  }
}
