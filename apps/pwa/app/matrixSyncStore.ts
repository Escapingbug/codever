import type { MatrixConnectionConfig } from "./matrix";

const operations = new Map<string, Promise<void>>();

export async function matrixSyncDatabaseName(
  config: Pick<
    MatrixConnectionConfig,
    "homeserver" | "userId" | "matrixDeviceId" | "roomId"
  >,
): Promise<string> {
  return `codever-matrix-sync-v1-${await scopeDigest([
    new URL(config.homeserver).origin,
    config.userId,
    config.matrixDeviceId,
    config.roomId,
  ])}`;
}

export async function matrixCryptoLockName(
  config: Pick<
    MatrixConnectionConfig,
    "homeserver" | "userId" | "matrixDeviceId"
  >,
): Promise<string> {
  return `codever-matrix-crypto-v1-${await scopeDigest([
    new URL(config.homeserver).origin,
    config.userId,
    config.matrixDeviceId,
  ])}`;
}

async function scopeDigest(scope: string[]): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(scope)),
    ),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
  return encoded;
}

type LockManagerLike = {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<void>,
  ): Promise<void>;
};

export type MatrixCryptoLock = {
  release(): Promise<void>;
};

export async function acquireMatrixCryptoLock(
  name: string,
  locks: LockManagerLike | undefined =
    typeof navigator === "undefined" ? undefined : navigator.locks,
): Promise<MatrixCryptoLock> {
  if (!locks) {
    throw new Error(
      "This browser cannot safely isolate the Matrix encryption database because Web Locks are unavailable. Use a supported browser, log in as a new Matrix device, and pair again.",
    );
  }
  let releaseHold: (() => void) | null = null;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let resolveGrant!: (lock: MatrixCryptoLock | null) => void;
  let rejectGrant!: (error: unknown) => void;
  const granted = new Promise<MatrixCryptoLock | null>((resolve, reject) => {
    resolveGrant = resolve;
    rejectGrant = reject;
  });
  let released = false;
  const release = async () => {
    if (!released) {
      released = true;
      releaseHold?.();
    }
    await requestPromise;
  };
  const requestPromise = locks.request(
    name,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        resolveGrant(null);
        return;
      }
      resolveGrant({ release });
      await hold;
    },
  );
  void requestPromise.catch(rejectGrant);
  const lock = await granted;
  if (!lock) {
    await requestPromise;
    throw new Error(
      "Another Codever tab is already using this Matrix device. Close it before reconnecting.",
    );
  }
  return lock;
}

export async function waitForMatrixSyncStoreClose(
  databaseName: string,
): Promise<void> {
  await operations.get(databaseName);
}

type ClosableMatrixSyncStore = {
  save(force?: boolean): Promise<void>;
  destroy(): Promise<void>;
};

function serializeStoreOperation(
  databaseName: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = operations.get(databaseName) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  operations.set(databaseName, current);
  const clear = () => {
    if (operations.get(databaseName) === current) operations.delete(databaseName);
  };
  void current.then(clear, clear);
  return current;
}

export function checkpointMatrixSyncStore(
  databaseName: string,
  store: ClosableMatrixSyncStore,
): Promise<void> {
  return serializeStoreOperation(databaseName, () => store.save(true));
}

export function destroyMatrixSyncStore(
  databaseName: string,
  store: ClosableMatrixSyncStore,
): Promise<void> {
  return serializeStoreOperation(databaseName, () => store.destroy());
}

export function checkpointAndReleaseMatrixSyncStore(
  databaseName: string,
  store: ClosableMatrixSyncStore,
  lock: MatrixCryptoLock,
): Promise<void> {
  return serializeStoreOperation(databaseName, async () => {
    try {
      await store.save(true);
    } finally {
      await lock.release();
    }
  });
}

export function destroyAndReleaseMatrixSyncStore(
  databaseName: string,
  store: ClosableMatrixSyncStore,
  lock: MatrixCryptoLock,
): Promise<void> {
  return serializeStoreOperation(databaseName, async () => {
    try {
      await store.destroy();
    } finally {
      await lock.release();
    }
  });
}
