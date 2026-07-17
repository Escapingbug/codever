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
  void openDatabase().then(database => {
    if (!database) return
    database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, key)
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
