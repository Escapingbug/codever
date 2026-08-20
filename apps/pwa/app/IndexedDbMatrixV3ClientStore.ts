import type {
  MatrixV3ClientStore,
  MatrixV3InboxRecord,
  MatrixV3OutboxRecord,
} from "./matrixV3Client";
import type { MatrixV3ProjectionState } from "./matrixV3Projection";

const DATABASE_NAME = "codever-matrix-v3";
const DATABASE_VERSION = 2;
const OUTBOX = "outbox";
const INBOX = "inbox";
const PROJECTION = "projection";

type OutboxRow = MatrixV3OutboxRecord & {
  key: string;
  scope: string;
  scopeStatus: string;
};

type InboxRow = MatrixV3InboxRecord & {
  key: string;
  scope: string;
  scopeStatus: string;
};

/** Durable browser raw-inbox and independent command-outbox storage. */
export class IndexedDbMatrixV3ClientStore implements MatrixV3ClientStore {
  constructor(private readonly scope: string) {
    if (!scope.trim()) throw new Error("Matrix v3 IndexedDB scope is required.");
  }

  async putOutbox(record: MatrixV3OutboxRecord): Promise<void> {
    const database = await openDatabase();
    try {
      await put(database, OUTBOX, this.outboxRow(record));
    } finally {
      database.close();
    }
  }

  async getOutbox(commandId: string): Promise<MatrixV3OutboxRecord | null> {
    const database = await openDatabase();
    try {
      const row = await get<OutboxRow>(database, OUTBOX, this.key(commandId));
      return row ? stripOutboxRow(row) : null;
    } finally {
      database.close();
    }
  }

  async listPendingOutbox(): Promise<MatrixV3OutboxRecord[]> {
    const database = await openDatabase();
    try {
      return (await readIndex<OutboxRow>(
        database,
        OUTBOX,
        "scopeStatus",
        IDBKeyRange.only(`${this.scope}\u0000pending`),
      )).map(stripOutboxRow);
    } finally {
      database.close();
    }
  }

  async putInbox(record: MatrixV3InboxRecord): Promise<boolean> {
    const database = await openDatabase();
    try {
      const key = this.key(record.raw.eventId);
      const transaction = database.transaction(INBOX, "readwrite", { durability: "strict" });
      const store = transaction.objectStore(INBOX);
      const existing = await request(store.getKey(key));
      if (existing !== undefined) {
        transaction.abort();
        return false;
      }
      store.add({
        ...structuredClone(record),
        key,
        scope: this.scope,
        scopeStatus: `${this.scope}\u0000${record.status}`,
      } satisfies InboxRow);
      await transactionDone(transaction);
      return true;
    } finally {
      database.close();
    }
  }

  async listPendingInbox(): Promise<MatrixV3InboxRecord[]> {
    const database = await openDatabase();
    try {
      return (await readIndex<InboxRow>(
        database,
        INBOX,
        "scopeStatus",
        IDBKeyRange.only(`${this.scope}\u0000pending`),
      )).map(stripInboxRow);
    } finally {
      database.close();
    }
  }

  async listInbox(): Promise<MatrixV3InboxRecord[]> {
    const database = await openDatabase();
    try {
      return (await readIndex<InboxRow>(
        database,
        INBOX,
        "scope",
        IDBKeyRange.only(this.scope),
      )).map(stripInboxRow);
    } finally {
      database.close();
    }
  }

  async updateInbox(
    eventId: string,
    update: Pick<MatrixV3InboxRecord, "status" | "error">,
  ): Promise<void> {
    const database = await openDatabase();
    try {
      const key = this.key(eventId);
      const transaction = database.transaction(INBOX, "readwrite", { durability: "strict" });
      const store = transaction.objectStore(INBOX);
      const row = await request<InboxRow | undefined>(store.get(key));
      if (!row) {
        transaction.abort();
        throw new Error(`Unknown raw Matrix event ${eventId}`);
      }
      store.put({
        ...row,
        status: update.status,
        scopeStatus: `${this.scope}\u0000${update.status}`,
        ...(update.error ? { error: update.error } : { error: undefined }),
      } satisfies InboxRow);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async loadProjection(): Promise<unknown | null> {
    const database = await openDatabase();
    try {
      const row = await get<{ key: string; state: unknown }>(
        database,
        PROJECTION,
        this.scope,
      );
      return row ? structuredClone(row.state) : null;
    } finally {
      database.close();
    }
  }

  async saveProjection(state: MatrixV3ProjectionState): Promise<void> {
    const database = await openDatabase();
    try {
      await put(database, PROJECTION, {
        key: this.scope,
        state: structuredClone(state),
      });
    } finally {
      database.close();
    }
  }

  async clearProjection(): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PROJECTION, "readwrite", { durability: "strict" });
      transaction.objectStore(PROJECTION).delete(this.scope);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  private key(id: string): string {
    return `${this.scope}\u0000${id}`;
  }

  private outboxRow(record: MatrixV3OutboxRecord): OutboxRow {
    return {
      ...structuredClone(record),
      key: this.key(record.command.commandId),
      scope: this.scope,
      scopeStatus: `${this.scope}\u0000${record.status}`,
    };
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opened = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    opened.onupgradeneeded = () => {
      const database = opened.result;
      if (!database.objectStoreNames.contains(OUTBOX)) {
        const store = database.createObjectStore(OUTBOX, { keyPath: "key" });
        store.createIndex("scopeStatus", "scopeStatus", { unique: false });
      }
      if (!database.objectStoreNames.contains(INBOX)) {
        const store = database.createObjectStore(INBOX, { keyPath: "key" });
        store.createIndex("scopeStatus", "scopeStatus", { unique: false });
        store.createIndex("scope", "scope", { unique: false });
      } else {
        const store = opened.transaction!.objectStore(INBOX);
        if (!store.indexNames.contains("scope")) {
          store.createIndex("scope", "scope", { unique: false });
        }
      }
      if (!database.objectStoreNames.contains(PROJECTION)) {
        database.createObjectStore(PROJECTION, { keyPath: "key" });
      }
    };
    opened.onsuccess = () => resolve(opened.result);
    opened.onerror = () => reject(opened.error ?? new Error("Matrix v3 IndexedDB open failed."));
    opened.onblocked = () => reject(new Error("Matrix v3 IndexedDB upgrade is blocked by another tab."));
  });
}

function put(database: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite", { durability: "strict" });
  transaction.objectStore(storeName).put(value);
  return transactionDone(transaction);
}

function get<T>(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const transaction = database.transaction(storeName, "readonly");
  return request<T | undefined>(transaction.objectStore(storeName).get(key));
}

function readIndex<T>(
  database: IDBDatabase,
  storeName: string,
  indexName: string,
  range: IDBKeyRange,
): Promise<T[]> {
  const transaction = database.transaction(storeName, "readonly");
  return request<T[]>(transaction.objectStore(storeName).index(indexName).getAll(range));
}

function request<T>(input: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    input.onsuccess = () => resolve(input.result);
    input.onerror = () => reject(input.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function stripOutboxRow(row: OutboxRow): MatrixV3OutboxRecord {
  const { key: _key, scope: _scope, scopeStatus: _scopeStatus, ...record } = row;
  return structuredClone(record);
}

function stripInboxRow(row: InboxRow): MatrixV3InboxRecord {
  const { key: _key, scope: _scope, scopeStatus: _scopeStatus, ...record } = row;
  return structuredClone(record);
}
