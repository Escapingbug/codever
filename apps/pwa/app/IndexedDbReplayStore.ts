import type { ReplayClaim, ReplayStore } from "@codever/security";

const DATABASE_NAME = "codever-pwa-security";
const STORE_NAME = "replay-claims";

type StoredClaim = ReplayClaim & { key: string };

/**
 * Browser replay protection backed by one atomic IndexedDB transaction.
 * A duplicate in any requested scope rejects the complete claim set.
 */
export class IndexedDbReplayStore implements ReplayStore {
  async claimAll(
    claims: readonly ReplayClaim[],
    now: number,
  ): Promise<boolean> {
    if (new Set(claims.map((claim) => claim.key)).size !== claims.length) {
      return false;
    }
    const database = await openReplayDatabase();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        let accepted = false;

        request.onsuccess = () => {
          const existing = request.result as StoredClaim[];
          const activeKeys = new Set<string>();
          for (const claim of existing) {
            if (claim.expiresAt <= now) store.delete(claim.key);
            else activeKeys.add(claim.key);
          }
          if (claims.some((claim) => activeKeys.has(claim.key))) return;
          for (const claim of claims) store.put(claim);
          accepted = true;
        };
        request.onerror = () =>
          transaction.abort();
        transaction.oncomplete = () => resolve(accepted);
        transaction.onabort = () =>
          reject(
            transaction.error ??
              request.error ??
              new Error("Could not persist the replay claim."),
          );
        transaction.onerror = () => {
          // onabort reports the final transaction error.
        };
      });
    } finally {
      database.close();
    }
  }

  async prune(now: number): Promise<void> {
    const database = await openReplayDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const claim = entry.value as StoredClaim;
          if (claim.expiresAt <= now) entry.delete();
          entry.continue();
        };
        cursor.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(
            transaction.error ??
              cursor.error ??
              new Error("Could not prune replay claims."),
          );
        transaction.onerror = () => {
          // onabort reports the final transaction error.
        };
      });
    } finally {
      database.close();
    }
  }
}

function openReplayDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("Could not open the replay protection store."),
      );
  });
}
