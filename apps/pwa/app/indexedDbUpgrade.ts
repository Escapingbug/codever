import type { PersistedStateClass } from "@codever/protocol";
import { CODEVER_BUILD_VERSION } from "./buildInfo";
import {
  MATRIX_IDENTITY_DATABASE_NAME,
  ensureMatrixIdentityDatabase,
} from "./matrix";
import {
  REPLAY_DATABASE_NAME,
  ensureReplayDatabase,
} from "./IndexedDbReplayStore";
import {
  MESSAGE_HISTORY_DATABASE_NAME,
  ensureMessageHistoryDatabase,
} from "./messageHistory";
import {
  MATRIX_CVP3_DATABASE_NAME,
  MATRIX_CVP3_OUTBOX_SCHEMA_VERSION,
  MATRIX_CVP3_READ_MODEL_SCHEMA_VERSION,
  ensureMatrixCvp3OutboxDatabase,
  ensureMatrixCvp3ReadModelDatabase,
  resetMatrixCvp3ReadModel,
} from "./IndexedDbMatrixCvp3ClientStore";
import type { UpgradeStorage } from "./stateUpgrade";

export const PWA_INDEXED_DB_MANIFEST_STORAGE_KEY =
  "codever.indexeddb-state-manifest.v1";
export const PWA_INDEXED_DB_MANIFEST_SCHEMA_VERSION = 1;
export const MATRIX_SYNC_DATABASE_PREFIX = "codever-matrix-sync-v1-";
export const MATRIX_CRYPTO_DATABASE_PREFIX = "codever-matrix-crypto-v1-";

type IndexedDbMigration = (fromVersion: number, toVersion: number) => Promise<void>;

export type PwaIndexedDbCatalogEntry = {
  id: string;
  databaseName: string;
  prefix?: boolean;
  stateClass: PersistedStateClass;
  schemaVersion: number;
  legacySchemaVersion: number;
  migrationFromVersions?: ReadonlySet<number>;
  migrate?: IndexedDbMigration;
  validate(): Promise<void>;
  reset(): Promise<void>;
};

type ManifestStore = {
  id: string;
  stateClass: PersistedStateClass;
  schemaVersion: number;
};

type IndexedDbManifest = {
  version: 1;
  phase: "running" | "blocked" | "complete";
  appBuild: string;
  startedAt: number;
  completedAt: number | null;
  stores: ManifestStore[];
  activeMigration: {
    id: string;
    fromVersion: number;
    toVersion: number;
  } | null;
  invalidated: string[];
  blocked: string[];
};

type IndexedDbManifestMigration = (value: IndexedDbManifest) => IndexedDbManifest;

/** A future manifest bump must register every adjacent step here. */
export const PWA_INDEXED_DB_MANIFEST_MIGRATIONS: Readonly<
  Record<number, IndexedDbManifestMigration | undefined>
> = Object.freeze({});

export class PwaIndexedDbUpgradeBlockedError extends Error {
  constructor(
    message: string,
    readonly blockedKeys: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PwaIndexedDbUpgradeBlockedError";
  }
}

export function pwaIndexedDbCatalog(
  factory: IDBFactory = indexedDB,
): readonly PwaIndexedDbCatalogEntry[] {
  const deleteOne = (name: string) => deleteDatabase(factory, name);
  return [
    {
      id: "matrix-identity-and-command-sequences",
      databaseName: MATRIX_IDENTITY_DATABASE_NAME,
      stateClass: "security-critical",
      schemaVersion: 3,
      legacySchemaVersion: 3,
      migrationFromVersions: new Set([1, 2]),
      migrate: async () => ensureMatrixIdentityDatabase(),
      validate: ensureMatrixIdentityDatabase,
      reset: () => deleteOne(MATRIX_IDENTITY_DATABASE_NAME),
    },
    {
      id: "replay-protection",
      databaseName: REPLAY_DATABASE_NAME,
      stateClass: "security-critical",
      schemaVersion: 1,
      legacySchemaVersion: 1,
      validate: ensureReplayDatabase,
      reset: () => deleteOne(REPLAY_DATABASE_NAME),
    },
    {
      id: "matrix-crypto-store",
      databaseName: MATRIX_CRYPTO_DATABASE_PREFIX,
      prefix: true,
      stateClass: "security-critical",
      schemaVersion: 1,
      legacySchemaVersion: 1,
      // matrix-js-sdk owns the physical object-store validation and opens it
      // only after this application-level version gate has completed.
      validate: async () => {},
      reset: () => deleteDatabasesWithPrefix(factory, MATRIX_CRYPTO_DATABASE_PREFIX),
    },
    {
      id: "cvp3-command-outbox",
      databaseName: MATRIX_CVP3_DATABASE_NAME,
      stateClass: "durable-command",
      schemaVersion: MATRIX_CVP3_OUTBOX_SCHEMA_VERSION,
      legacySchemaVersion: 1,
      validate: () => ensureMatrixCvp3OutboxDatabase(factory),
      // Explicit whole-device repair may discard this database, but automatic
      // version upgrades never invoke reset for a durable-command entry.
      reset: () => deleteOne(MATRIX_CVP3_DATABASE_NAME),
    },
    {
      id: "cvp3-inbox-and-projection",
      databaseName: MATRIX_CVP3_DATABASE_NAME,
      stateClass: "rebuildable-projection",
      schemaVersion: MATRIX_CVP3_READ_MODEL_SCHEMA_VERSION,
      legacySchemaVersion: 1,
      validate: () => ensureMatrixCvp3ReadModelDatabase(factory),
      reset: () => resetMatrixCvp3ReadModel(factory),
    },
    {
      id: "conversation-history-projection",
      databaseName: MESSAGE_HISTORY_DATABASE_NAME,
      stateClass: "rebuildable-projection",
      schemaVersion: 1,
      legacySchemaVersion: 1,
      validate: ensureMessageHistoryDatabase,
      reset: () => deleteOne(MESSAGE_HISTORY_DATABASE_NAME),
    },
    {
      id: "matrix-sync-projection",
      databaseName: MATRIX_SYNC_DATABASE_PREFIX,
      prefix: true,
      stateClass: "rebuildable-projection",
      schemaVersion: 1,
      legacySchemaVersion: 1,
      validate: async () => {},
      reset: () => deleteDatabasesWithPrefix(factory, MATRIX_SYNC_DATABASE_PREFIX),
    },
  ];
}

/** Async half of the PWA startup gate, covering every IndexedDB family. */
export async function runPwaIndexedDbUpgrade(
  storage: UpgradeStorage,
  factory: IDBFactory = indexedDB,
  now = Date.now(),
  catalog: readonly PwaIndexedDbCatalogEntry[] = pwaIndexedDbCatalog(factory),
): Promise<void> {
  validateCatalog(catalog);
  const manifestRaw = storage.getItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY);
  let previous = parseManifest(manifestRaw);
  if (manifestRaw !== null && previous === null) {
    const names = await existingDatabaseNames(factory);
    const protectedDatabases = catalog
      .filter(entry => !isDiscardable(entry.stateClass))
      .filter(entry => names === null || databaseEntryExists(names, entry))
      .map(entry => entry.databaseName);
    if (protectedDatabases.length > 0) {
      throw new PwaIndexedDbUpgradeBlockedError(
        "The browser database upgrade journal is damaged. Identity and replay state was preserved; reset and pair again only if it cannot be recovered.",
        [...new Set(protectedDatabases)].sort(),
      );
    }
    for (const entry of catalog.filter(entry => isDiscardable(entry.stateClass))) {
      await entry.reset();
    }
    storage.removeItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY);
    previous = null;
  }
  previous = migrateManifest(previous);
  const prior = new Map(
    (previous?.stores ?? catalog.map(entry => store(entry, entry.legacySchemaVersion)))
      .map(value => [value.id, value]),
  );
  let manifest: IndexedDbManifest = {
    version: PWA_INDEXED_DB_MANIFEST_SCHEMA_VERSION,
    phase: "running",
    appBuild: CODEVER_BUILD_VERSION,
    startedAt: previous?.phase === "running" ? previous.startedAt : now,
    completedAt: null,
    stores: catalog.map(entry => prior.get(entry.id) ?? store(entry, entry.legacySchemaVersion)),
    activeMigration: previous?.activeMigration ?? null,
    invalidated: previous?.phase === "running" ? previous.invalidated : [],
    blocked: [],
  };
  const checkpoint = (next: IndexedDbManifest) => {
    storage.setItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY, JSON.stringify(next));
    manifest = next;
  };
  checkpoint(manifest);

  const blocked: string[] = [];
  try {
    for (const entry of catalog) {
      const recorded = manifest.stores.find(value => value.id === entry.id)!;
      if (recorded.stateClass !== entry.stateClass) {
        blocked.push(entry.databaseName);
        continue;
      }
      let fromVersion = recorded.schemaVersion;
      if (fromVersion > entry.schemaVersion) {
        if (isDiscardable(entry.stateClass)) {
          await entry.reset();
          checkpointStore(entry, entry.schemaVersion, true);
        } else {
          blocked.push(entry.databaseName);
        }
        continue;
      }
      while (fromVersion < entry.schemaVersion) {
        if (isDiscardable(entry.stateClass)) {
          await entry.reset();
          checkpointStore(entry, entry.schemaVersion, true);
          fromVersion = entry.schemaVersion;
          break;
        }
        if (!entry.migrationFromVersions?.has(fromVersion) || !entry.migrate) {
          blocked.push(entry.databaseName);
          break;
        }
        checkpoint({
          ...manifest,
          activeMigration: { id: entry.id, fromVersion, toVersion: fromVersion + 1 },
        });
        await entry.migrate(fromVersion, fromVersion + 1);
        fromVersion += 1;
        checkpointStore(entry, fromVersion, false);
      }
      if (blocked.includes(entry.databaseName)) continue;
      try {
        await entry.validate();
      } catch (error) {
        if (!isDiscardable(entry.stateClass)) {
          blocked.push(entry.databaseName);
          throw error;
        }
        await entry.reset();
        checkpointStore(entry, entry.schemaVersion, true);
      }
    }
  } catch (error) {
    if (blocked.length === 0 && manifest.activeMigration) {
      const activeEntry = catalog.find(entry => entry.id === manifest.activeMigration?.id);
      if (activeEntry) blocked.push(activeEntry.databaseName);
    }
    checkpoint({ ...manifest, phase: "blocked", blocked });
    throw new PwaIndexedDbUpgradeBlockedError(
      "Codever could not finish upgrading browser databases.",
      blocked,
      { cause: error },
    );
  }
  if (blocked.length > 0) {
    checkpoint({ ...manifest, phase: "blocked", activeMigration: null, blocked });
    throw new PwaIndexedDbUpgradeBlockedError(
      "A security database needs an explicit migration and was preserved.",
      blocked,
    );
  }
  checkpoint({
    ...manifest,
    phase: "complete",
    completedAt: now,
    stores: catalog.map(entry => store(entry, entry.schemaVersion)),
    activeMigration: null,
    invalidated: [...new Set(manifest.invalidated)].sort(),
    blocked: [],
  });

  function checkpointStore(
    entry: PwaIndexedDbCatalogEntry,
    schemaVersion: number,
    invalidated: boolean,
  ) {
    checkpoint({
      ...manifest,
      stores: manifest.stores.map(value =>
        value.id === entry.id ? store(entry, schemaVersion) : value),
      activeMigration: null,
      invalidated: invalidated
        ? [...new Set([...manifest.invalidated, entry.id])].sort()
        : manifest.invalidated,
    });
  }
}

export async function resetBlockedPwaIndexedDb(
  storage: UpgradeStorage,
  factory: IDBFactory,
  blockedKeys: readonly string[],
  catalog: readonly PwaIndexedDbCatalogEntry[] = pwaIndexedDbCatalog(factory),
): Promise<void> {
  for (const name of blockedKeys) {
    if (name.endsWith("-")) await deleteDatabasesWithPrefix(factory, name);
    else await deleteDatabase(factory, name);
  }
  for (const entry of catalog.filter(entry => isDiscardable(entry.stateClass))) {
    await entry.reset();
  }
  storage.removeItem(PWA_INDEXED_DB_MANIFEST_STORAGE_KEY);
}

function validateCatalog(catalog: readonly PwaIndexedDbCatalogEntry[]) {
  if (new Set(catalog.map(entry => entry.id)).size !== catalog.length) {
    throw new Error("IndexedDB state catalog IDs must be unique.");
  }
  for (const entry of catalog) {
    if (
      !entry.id ||
      !entry.databaseName ||
      !Number.isSafeInteger(entry.schemaVersion) ||
      entry.schemaVersion < 1 ||
      !Number.isSafeInteger(entry.legacySchemaVersion) ||
      entry.legacySchemaVersion < 1 ||
      entry.legacySchemaVersion > entry.schemaVersion
    ) {
      throw new Error(`IndexedDB state catalog entry ${entry.id} is invalid.`);
    }
  }
}

function store(entry: PwaIndexedDbCatalogEntry, schemaVersion: number): ManifestStore {
  return { id: entry.id, stateClass: entry.stateClass, schemaVersion };
}

function isDiscardable(stateClass: PersistedStateClass): boolean {
  return stateClass === "rebuildable-projection" || stateClass === "ephemeral-ui";
}

function parseManifest(raw: string | null): IndexedDbManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as IndexedDbManifest;
    if (!Number.isSafeInteger(value.version)) return null;
    if (value.version > PWA_INDEXED_DB_MANIFEST_SCHEMA_VERSION) return value;
    if (
      value.version !== PWA_INDEXED_DB_MANIFEST_SCHEMA_VERSION ||
      !["running", "blocked", "complete"].includes(value.phase) ||
      typeof value.appBuild !== "string" ||
      !Number.isFinite(value.startedAt) ||
      !(value.completedAt === null || Number.isFinite(value.completedAt)) ||
      !isManifestStores(value.stores) ||
      !isActiveMigration(value.activeMigration) ||
      !isStringArray(value.invalidated) ||
      !isStringArray(value.blocked)
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function migrateManifest(previous: IndexedDbManifest | null): IndexedDbManifest | null {
  if (!previous) return null;
  if (previous.version > PWA_INDEXED_DB_MANIFEST_SCHEMA_VERSION) {
    throw new PwaIndexedDbUpgradeBlockedError(
      "This build cannot downgrade IndexedDB state written by a newer Codever version.",
      [],
    );
  }
  let current = previous;
  while (current.version < PWA_INDEXED_DB_MANIFEST_SCHEMA_VERSION) {
    const migration = PWA_INDEXED_DB_MANIFEST_MIGRATIONS[current.version];
    if (!migration) {
      throw new PwaIndexedDbUpgradeBlockedError(
        `The IndexedDB upgrade journal has no ${current.version} -> ${current.version + 1} migration.`,
        [],
      );
    }
    const from = current.version;
    current = migration(current);
    if (current.version !== from + 1) {
      throw new Error(`IndexedDB manifest migration ${from} must produce ${from + 1}.`);
    }
  }
  return current;
}

function isManifestStores(value: unknown): value is ManifestStore[] {
  return Array.isArray(value) && value.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return (
      typeof entry.id === "string" &&
      ["security-critical", "durable-command", "rebuildable-projection", "ephemeral-ui"]
        .includes(String(entry.stateClass)) &&
      Number.isSafeInteger(entry.schemaVersion) &&
      (entry.schemaVersion as number) >= 1
    );
  });
}

function isActiveMigration(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const migration = value as Record<string, unknown>;
  return (
    typeof migration.id === "string" &&
    Number.isSafeInteger(migration.fromVersion) &&
    Number.isSafeInteger(migration.toVersion) &&
    Number(migration.toVersion) === Number(migration.fromVersion) + 1
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

async function existingDatabaseNames(factory: IDBFactory): Promise<Set<string> | null> {
  if (typeof factory.databases !== "function") return null;
  try {
    const databases = await factory.databases();
    return new Set(databases.map(database => database.name).filter((name): name is string => Boolean(name)));
  } catch {
    return null;
  }
}

function databaseEntryExists(
  names: ReadonlySet<string>,
  entry: PwaIndexedDbCatalogEntry,
): boolean {
  return entry.prefix
    ? [...names].some(name => name.startsWith(entry.databaseName))
    : names.has(entry.databaseName);
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not reset ${name}.`));
    request.onblocked = () => reject(new Error(`${name} is still open in another tab.`));
  });
}

async function deleteDatabasesWithPrefix(
  factory: IDBFactory,
  prefix: string,
): Promise<void> {
  const databases = typeof factory.databases === "function"
    ? await factory.databases()
    : [];
  await Promise.all(
    databases
      .map(database => database.name)
      .filter((name): name is string => Boolean(name?.startsWith(prefix)))
      .map(name => deleteDatabase(factory, name)),
  );
}
