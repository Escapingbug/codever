import {
  CODEVER_PROTOCOL_VERSION,
  migrateVersionedState,
  type PersistedStateClass,
  type StateMigration,
  type VersionedState,
} from "@codever/protocol";
import { NATIVE_BRIDGE_PROTOCOL_VERSION } from "@codever/native-bridge";
import { CODEVER_BUILD_VERSION } from "./buildInfo";
import { MATRIX_CONFIG_STORAGE_KEY } from "./matrix";
import {
  PAIRING_TRUST_STORAGE_KEY,
  PENDING_PAIRING_STORAGE_KEY,
} from "./pairing";
import { PROJECT_DISCLOSURE_STORAGE_KEY } from "./projectDisclosureState";
import {
  PENDING_SESSION_CREATE_STORAGE_KEY,
  readPendingSessionCreateRecovery,
} from "./sessionCreateRecovery";
import { SESSION_READ_STATE_STORAGE_KEY } from "./sessionIndicators";
import { SELECTED_SESSION_STORAGE_PREFIX } from "./selectedSessionState";
import { NATIVE_CURSOR_STORAGE_PREFIX } from "./client/native/storageKeys";

export const PWA_STATE_MANIFEST_STORAGE_KEY = "codever.state-manifest.v1";
export const PWA_STATE_SCHEMA_VERSION = 1;
export const PWA_STATE_MANIFEST_MIGRATIONS: Readonly<
  Record<number, StateMigration | undefined>
> = Object.freeze({ 0: migratePwaManifestV0 });

export type UpgradeStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

type StoreMigrationContext = {
  storage: UpgradeStorage;
  entry: PwaStateCatalogEntry;
  fromVersion: number;
  toVersion: number;
};

export type PwaStateCatalogEntry = {
  id: string;
  key: string;
  prefix: boolean;
  stateClass: PersistedStateClass;
  /** Version written by this build. */
  schemaVersion: number;
  /** Version of pre-manifest data already in the field. */
  legacySchemaVersion: number;
  /** Explicit N -> N+1 migrations; every function must be idempotent. */
  migrations?: Readonly<Record<number, ((context: StoreMigrationContext) => void) | undefined>>;
  validate?(storage: UpgradeStorage): boolean;
};

const jsonObjectValidator = (key: string) => (storage: UpgradeStorage): boolean => {
  const raw = storage.getItem(key);
  if (raw === null) return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
};

const versionedJsonValidator = (key: string, version: number) =>
  (storage: UpgradeStorage): boolean => {
    const raw = storage.getItem(key);
    if (raw === null) return true;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Boolean(
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).version === version,
      );
    } catch {
      return false;
    }
  };

/**
 * The ownership decision for every browser-persisted state family. A future
 * schema bump is incomplete until this entry changes and every adjacent
 * security/durable migration is registered here.
 */
export const PWA_STATE_CATALOG: readonly PwaStateCatalogEntry[] = Object.freeze([
  {
    id: "matrix-connection",
    key: MATRIX_CONFIG_STORAGE_KEY,
    prefix: false,
    stateClass: "security-critical",
    schemaVersion: 1,
    legacySchemaVersion: 1,
    validate: jsonObjectValidator(MATRIX_CONFIG_STORAGE_KEY),
  },
  {
    id: "gateway-trust",
    key: PAIRING_TRUST_STORAGE_KEY,
    prefix: false,
    stateClass: "security-critical",
    schemaVersion: 1,
    legacySchemaVersion: 1,
    validate: jsonObjectValidator(PAIRING_TRUST_STORAGE_KEY),
  },
  {
    id: "pending-pairing",
    key: PENDING_PAIRING_STORAGE_KEY,
    prefix: false,
    stateClass: "durable-command",
    schemaVersion: 1,
    legacySchemaVersion: 1,
    validate: jsonObjectValidator(PENDING_PAIRING_STORAGE_KEY),
  },
  {
    id: "pending-session-create-projection",
    key: PENDING_SESSION_CREATE_STORAGE_KEY,
    prefix: false,
    stateClass: "rebuildable-projection",
    schemaVersion: 1,
    legacySchemaVersion: 1,
    validate: storage =>
      storage.getItem(PENDING_SESSION_CREATE_STORAGE_KEY) === null ||
      readPendingSessionCreateRecovery(storage) !== null,
  },
  {
    id: "native-event-cursor",
    key: `${NATIVE_CURSOR_STORAGE_PREFIX}.`,
    prefix: true,
    stateClass: "rebuildable-projection",
    schemaVersion: 1,
    legacySchemaVersion: 1,
  },
  {
    id: "selected-session",
    key: `${SELECTED_SESSION_STORAGE_PREFIX}.`,
    prefix: true,
    stateClass: "ephemeral-ui",
    schemaVersion: 1,
    legacySchemaVersion: 1,
    validate: storage => matchingKeys(storage, `${SELECTED_SESSION_STORAGE_PREFIX}.`)
      .every(key => {
        const value = storage.getItem(key);
        return Boolean(value && value.length <= 512);
      }),
  },
  {
    id: "project-disclosure",
    key: PROJECT_DISCLOSURE_STORAGE_KEY,
    prefix: false,
    stateClass: "ephemeral-ui",
    schemaVersion: 1,
    legacySchemaVersion: 1,
    validate: versionedJsonValidator(PROJECT_DISCLOSURE_STORAGE_KEY, 1),
  },
  {
    id: "session-read-markers",
    key: SESSION_READ_STATE_STORAGE_KEY,
    prefix: false,
    stateClass: "ephemeral-ui",
    schemaVersion: 1,
    legacySchemaVersion: 1,
    validate: versionedJsonValidator(SESSION_READ_STATE_STORAGE_KEY, 1),
  },
]);

type ManifestStore = {
  id: string;
  stateClass: PersistedStateClass;
  schemaVersion: number;
};

type ActiveStoreMigration = {
  id: string;
  fromVersion: number;
  toVersion: number;
};

type PwaStateManifest = {
  version: 1;
  phase: "running" | "blocked" | "complete";
  appBuild: string;
  // Persisted field name from the first CVP/3 release. Keep it until a
  // versioned manifest migration can rename it without discarding state.
  matrixProtocol: number;
  nativeBridgeProtocol: number;
  startedAt: number;
  completedAt: number | null;
  migratedFrom: number | null;
  stores: ManifestStore[];
  activeMigration: ActiveStoreMigration | null;
  invalidated: string[];
  blocked: string[];
};

export type PwaStateUpgradeResult = {
  migratedFrom: number | null;
  invalidated: readonly string[];
};

export class PwaStateUpgradeBlockedError extends Error {
  constructor(
    message: string,
    readonly blockedKeys: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PwaStateUpgradeBlockedError";
  }
}

/**
 * Runs before connection, trust, command recovery, or UI cache restoration.
 * The manifest is a per-store checkpoint. If the process stops between a
 * store write and its checkpoint, the same idempotent adjacent migration is
 * replayed on the next start.
 */
export function runPwaStateUpgrade(
  storage: UpgradeStorage,
  now = Date.now(),
  catalog: readonly PwaStateCatalogEntry[] = PWA_STATE_CATALOG,
): PwaStateUpgradeResult {
  validateCatalog(catalog);
  let manifestRaw: string | null;
  let previous: PwaStateManifest | null;
  try {
    manifestRaw = storage.getItem(PWA_STATE_MANIFEST_STORAGE_KEY);
    previous = parseManifest(manifestRaw);
  } catch (error) {
    throw new PwaStateUpgradeBlockedError(
      "This browser did not allow Codever to inspect its saved state.",
      [],
      { cause: error },
    );
  }

  if (manifestRaw !== null && previous === null) {
    const protectedKeys = catalog
      .filter(entry => !isDiscardable(entry.stateClass) && entryHasData(storage, entry))
      .map(entry => entry.key);
    if (protectedKeys.length > 0) {
      throw new PwaStateUpgradeBlockedError(
        "The browser upgrade journal is damaged. Security and queued-command state was preserved; reset and pair again only if this state cannot be recovered.",
        [...new Set(protectedKeys)].sort(),
      );
    }
    // With no protected state, an unreadable journal cannot tell us which
    // build wrote projections. Reset only the discardable families and create
    // a fresh manifest from the legacy baseline.
    catalog
      .filter(entry => isDiscardable(entry.stateClass))
      .forEach(entry => resetEntry(storage, entry));
    storage.removeItem(PWA_STATE_MANIFEST_STORAGE_KEY);
  }

  let manifestMigration: ReturnType<typeof migrateVersionedState>;
  try {
    manifestMigration = migrateVersionedState({
      label: "Codever browser state",
      value: previous ?? { version: 0 },
      currentVersion: PWA_STATE_SCHEMA_VERSION,
      migrations: PWA_STATE_MANIFEST_MIGRATIONS,
    });
  } catch (error) {
    throw new PwaStateUpgradeBlockedError(
      "This Codever build cannot safely downgrade browser state written by a newer version.",
      [],
      { cause: error },
    );
  }

  const priorStores = new Map(
    (previous?.stores ?? catalog.map(entry => manifestStore(entry, entry.legacySchemaVersion)))
      .map(store => [store.id, store]),
  );
  let running: PwaStateManifest = {
    version: 1,
    phase: "running",
    appBuild: CODEVER_BUILD_VERSION,
    matrixProtocol: CODEVER_PROTOCOL_VERSION,
    nativeBridgeProtocol: NATIVE_BRIDGE_PROTOCOL_VERSION,
    startedAt: previous?.phase === "running" ? previous.startedAt : now,
    completedAt: null,
    migratedFrom: manifestMigration.migratedFrom,
    stores: catalog.map(entry =>
      priorStores.get(entry.id) ?? manifestStore(entry, entry.legacySchemaVersion)),
    activeMigration: previous?.activeMigration ?? null,
    invalidated: previous?.phase === "running" ? previous.invalidated : [],
    blocked: [],
  };
  writeManifest(storage, running);

  const blockedKeys: string[] = [];
  const checkpoint = (next: PwaStateManifest) => {
    running = next;
    writeManifest(storage, running);
  };
  try {
    for (const entry of catalog) {
      const recorded = running.stores.find(store => store.id === entry.id)!;
      if (recorded.stateClass !== entry.stateClass) {
        blockedKeys.push(entry.key);
        continue;
      }
      let fromVersion = recorded.schemaVersion;
      if (fromVersion > entry.schemaVersion) {
        if (isDiscardable(entry.stateClass)) {
          resetEntry(storage, entry);
          checkpointStore(entry, entry.schemaVersion, true);
        } else {
          blockedKeys.push(entry.key);
        }
        continue;
      }
      while (fromVersion < entry.schemaVersion) {
        if (isDiscardable(entry.stateClass)) {
          resetEntry(storage, entry);
          checkpointStore(entry, entry.schemaVersion, true);
          fromVersion = entry.schemaVersion;
          break;
        }
        const migration = entry.migrations?.[fromVersion];
        if (!migration) {
          blockedKeys.push(entry.key);
          break;
        }
        const activeMigration = {
          id: entry.id,
          fromVersion,
          toVersion: fromVersion + 1,
        };
        checkpoint({ ...running, activeMigration });
        migration({
          storage,
          entry,
          fromVersion,
          toVersion: fromVersion + 1,
        });
        fromVersion += 1;
        checkpointStore(entry, fromVersion, false);
      }
      if (blockedKeys.includes(entry.key)) continue;
      if (entry.validate && !entry.validate(storage)) {
        if (isDiscardable(entry.stateClass)) {
          resetEntry(storage, entry);
          checkpointStore(entry, entry.schemaVersion, true);
        } else {
          blockedKeys.push(entry.key);
        }
      }
    }
  } catch (error) {
    try {
      checkpoint({ ...running, phase: "blocked", blocked: blockedKeys });
    } catch {
      // Preserve the original store/migration error.
    }
    throw new PwaStateUpgradeBlockedError(
      "Codever could not finish upgrading this browser's saved state.",
      blockedKeys,
      { cause: error },
    );
  }

  if (blockedKeys.length > 0) {
    checkpoint({
      ...running,
      phase: "blocked",
      activeMigration: null,
      blocked: [...new Set(blockedKeys)].sort(),
    });
    throw new PwaStateUpgradeBlockedError(
      "Saved security or command state needs an explicit migration and was preserved instead of being silently deleted.",
      [...new Set(blockedKeys)].sort(),
    );
  }

  const invalidated = [...new Set(running.invalidated)].sort();
  checkpoint({
    ...running,
    phase: "complete",
    completedAt: now,
    stores: catalog.map(entry => manifestStore(entry, entry.schemaVersion)),
    activeMigration: null,
    invalidated,
    blocked: [],
  });
  return { migratedFrom: manifestMigration.migratedFrom, invalidated };

  function checkpointStore(
    entry: PwaStateCatalogEntry,
    schemaVersion: number,
    invalidated: boolean,
  ) {
    checkpoint({
      ...running,
      stores: running.stores.map(store =>
        store.id === entry.id ? manifestStore(entry, schemaVersion) : store),
      activeMigration: null,
      invalidated: invalidated
        ? [...new Set([...running.invalidated, entry.id])].sort()
        : running.invalidated,
    });
  }
}

/** Explicit user recovery clears only the stores named by the blocked screen. */
export function resetBlockedPwaConnection(
  storage: UpgradeStorage,
  blockedKeys: readonly string[],
  catalog: readonly PwaStateCatalogEntry[] = PWA_STATE_CATALOG,
): void {
  for (const key of blockedKeys) {
    if (key.endsWith(".")) {
      matchingKeys(storage, key).forEach(candidate => storage.removeItem(candidate));
    } else {
      storage.removeItem(key);
    }
  }
  // Once the version journal is discarded, projections no longer have a
  // trustworthy source schema. Clear only the catalogued discardable stores;
  // they will be rebuilt from authenticated Matrix state after re-pairing.
  catalog
    .filter(entry => isDiscardable(entry.stateClass))
    .forEach(entry => resetEntry(storage, entry));
  storage.removeItem(PWA_STATE_MANIFEST_STORAGE_KEY);
}

function migratePwaManifestV0(value: VersionedState): VersionedState {
  return { ...value, version: 1 };
}

function validateCatalog(catalog: readonly PwaStateCatalogEntry[]): void {
  const ids = new Set<string>();
  for (const entry of catalog) {
    if (!entry.id || ids.has(entry.id)) throw new Error("PWA state catalog IDs must be unique.");
    ids.add(entry.id);
    if (
      !entry.key ||
      !Number.isSafeInteger(entry.schemaVersion) ||
      entry.schemaVersion < 1 ||
      !Number.isSafeInteger(entry.legacySchemaVersion) ||
      entry.legacySchemaVersion < 1 ||
      entry.legacySchemaVersion > entry.schemaVersion
    ) {
      throw new Error(`PWA state catalog entry ${entry.id} is invalid.`);
    }
  }
}

function manifestStore(
  entry: PwaStateCatalogEntry,
  schemaVersion: number,
): ManifestStore {
  return { id: entry.id, stateClass: entry.stateClass, schemaVersion };
}

function isDiscardable(stateClass: PersistedStateClass): boolean {
  return stateClass === "rebuildable-projection" || stateClass === "ephemeral-ui";
}

function resetEntry(storage: UpgradeStorage, entry: PwaStateCatalogEntry): void {
  if (entry.prefix) matchingKeys(storage, entry.key).forEach(key => storage.removeItem(key));
  else storage.removeItem(entry.key);
}

function entryHasData(storage: UpgradeStorage, entry: PwaStateCatalogEntry): boolean {
  return entry.prefix
    ? matchingKeys(storage, entry.key).length > 0
    : storage.getItem(entry.key) !== null;
}

function matchingKeys(
  storage: Pick<Storage, "key" | "length">,
  prefix: string,
): string[] {
  return storageKeys(storage).filter(key => key.startsWith(prefix));
}

function parseManifest(raw: string | null): PwaStateManifest | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // The journal is coordination metadata. Source stores remain untouched and
    // their idempotent validation/migrations can reconstruct it.
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.version)) return null;
  if ((record.version as number) > PWA_STATE_SCHEMA_VERSION) {
    return value as PwaStateManifest;
  }
  if (
    record.version !== 1 ||
    !["running", "blocked", "complete"].includes(String(record.phase)) ||
    typeof record.appBuild !== "string" ||
    !Number.isSafeInteger(record.matrixProtocol) ||
    !Number.isSafeInteger(record.nativeBridgeProtocol) ||
    !Number.isFinite(record.startedAt) ||
    !(record.completedAt === null || Number.isFinite(record.completedAt)) ||
    !(record.migratedFrom === null || Number.isSafeInteger(record.migratedFrom)) ||
    !isManifestStores(record.stores) ||
    !isActiveMigration(record.activeMigration) ||
    !isStringArray(record.invalidated) ||
    !isStringArray(record.blocked)
  ) {
    return null;
  }
  return value as PwaStateManifest;
}

function isManifestStores(value: unknown): value is ManifestStore[] {
  return Array.isArray(value) && value.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const store = item as Record<string, unknown>;
    return (
      typeof store.id === "string" &&
      ["security-critical", "durable-command", "rebuildable-projection", "ephemeral-ui"]
        .includes(String(store.stateClass)) &&
      Number.isSafeInteger(store.schemaVersion) &&
      (store.schemaVersion as number) >= 1
    );
  });
}

function isActiveMigration(value: unknown): value is ActiveStoreMigration | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const migration = value as Record<string, unknown>;
  return (
    typeof migration.id === "string" &&
    Number.isSafeInteger(migration.fromVersion) &&
    Number.isSafeInteger(migration.toVersion) &&
    migration.toVersion === (migration.fromVersion as number) + 1
  );
}

function storageKeys(storage: Pick<Storage, "key" | "length">): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function writeManifest(
  storage: Pick<Storage, "setItem">,
  manifest: PwaStateManifest,
): void {
  storage.setItem(PWA_STATE_MANIFEST_STORAGE_KEY, JSON.stringify(manifest));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
