const DATABASE_NAME = 'codever-client-cache'
const STORE_NAME = 'snapshots'
const DATABASE_VERSION = 1

const memory = new Map<string, unknown>()

export async function readCached<T>(key: string): Promise<T | undefined> {
  if (memory.has(key)) return memory.get(key) as T
  const database = await openDatabase()
  if (!database) return undefined
  return new Promise<T | undefined>((resolve) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => {
      const value = request.result as T | undefined
      if (value !== undefined) memory.set(key, value)
      resolve(value)
    }
    request.onerror = () => resolve(undefined)
  })
}

export function writeCached(key: string, value: unknown): void {
  memory.set(key, value)
  void writeCachedDurable(key, value)
}

/** Resolves only after IndexedDB commits, so a durable transport message can be safely ACKed. */
export async function writeCachedDurable(key: string, value: unknown): Promise<void> {
  memory.set(key, value)
  const database = await openDatabase()
  if (!database) {
    if (typeof indexedDB === 'undefined') return
    throw new Error('Client cache database is unavailable')
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Client cache transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Client cache transaction was aborted'))
  })
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined)
  return new Promise(resolve => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
  })
}
