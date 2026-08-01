import type {
  MessageFormat,
  ToolGroupPresentation,
} from "./presentation";
import type { CodeverAttachment } from "@codever/protocol";

export type PersistedChatMessage = {
  id: string;
  kind: "notice" | "user" | "agent" | "tool" | "permission" | "error";
  text?: string;
  time?: string;
  timestamp?: number;
  eventId?: string;
  operationId?: string;
  requestId?: string;
  streamId?: string;
  toolCallId?: string;
  toolStatus?: "running" | "succeeded" | "failed";
  replacesEventId?: string;
  commandId?: string;
  revision?: number;
  deliveryState?: "sending" | "sent" | "failed";
  originDeviceId?: string;
  originDeviceName?: string;
  format?: MessageFormat;
  toolGroup?: ToolGroupPresentation;
  attachments?: CodeverAttachment[];
  raw?: Record<string, unknown>;
};

export type MessageHistoryCursor = {
  timestamp: number;
  id: string;
};

export type MessageHistoryPage = {
  messages: PersistedChatMessage[];
  cursor: MessageHistoryCursor | null;
  hasMore: boolean;
};

const DATABASE_NAME = "codever-pwa-message-history";
const DATABASE_VERSION = 1;
const MESSAGE_STORE = "messages";
const BY_SESSION_INDEX = "by-session";
const BY_SCOPE_INDEX = "by-scope";
const DEFAULT_PAGE_SIZE = 30;
let historyWriteChain: Promise<void> = Promise.resolve();

type StoredChatMessage = Omit<PersistedChatMessage, "timestamp"> & {
  key: string;
  scope: string;
  sessionId: string;
  timestamp: number;
};

export function matrixHistoryScope(input: {
  gatewayId: string;
  conversationId: string;
  roomId: string;
}): string {
  return JSON.stringify([
    input.gatewayId,
    input.conversationId,
    input.roomId,
  ]);
}

export async function saveMessageHistory(
  scope: string,
  sessionId: string,
  messages: readonly PersistedChatMessage[],
): Promise<void> {
  if (!scope || !sessionId || messages.length === 0) return;
  return enqueueHistoryWrite(async () => {
    const database = await openHistoryDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(MESSAGE_STORE, "readwrite");
        const store = transaction.objectStore(MESSAGE_STORE);
        for (const message of messages) {
          store.put(storedChatMessage(scope, sessionId, message));
        }
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(
            transaction.error ??
              new Error("Could not persist the conversation history."),
          );
        transaction.onerror = () => {
          // onabort reports the final transaction error.
        };
      });
    } finally {
      database.close();
    }
  });
}

export async function reconcileMessageHistory(
  scope: string,
  sessionId: string,
  message: PersistedChatMessage,
  optimisticMessageId?: string,
): Promise<void> {
  if (!scope || !sessionId) return;
  return enqueueHistoryWrite(async () => {
    const database = await openHistoryDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(MESSAGE_STORE, "readwrite");
        const store = transaction.objectStore(MESSAGE_STORE);
        const index = store.index(BY_SESSION_INDEX);
        const range = IDBKeyRange.bound(
          [scope, sessionId, 0, ""],
          [scope, sessionId, Number.MAX_SAFE_INTEGER, "\uffff"],
        );
        const request = index.openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            store.put(storedChatMessage(scope, sessionId, message));
            return;
          }
          const candidate = cursor.value as StoredChatMessage;
          if (
            candidate.id !== message.id &&
            (candidate.id === optimisticMessageId ||
              (message.commandId &&
                candidate.kind === "user" &&
                candidate.commandId === message.commandId))
          ) {
            cursor.delete();
          }
          cursor.continue();
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(
            transaction.error ??
              request.error ??
              new Error("Could not reconcile the conversation history."),
          );
        transaction.onerror = () => {
          // onabort reports the final transaction error.
        };
      });
    } finally {
      database.close();
    }
  });
}

export async function deleteMessageHistory(
  scope: string,
  messageId: string,
): Promise<void> {
  if (!scope || !messageId) return;
  return enqueueHistoryWrite(async () => {
    const database = await openHistoryDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(MESSAGE_STORE, "readwrite");
        transaction
          .objectStore(MESSAGE_STORE)
          .delete(historyMessageKey(scope, messageId));
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(
            transaction.error ??
              new Error("Could not delete the conversation history message."),
          );
        transaction.onerror = () => {
          // onabort reports the final transaction error.
        };
      });
    } finally {
      database.close();
    }
  });
}

export async function loadMessageHistoryPage(
  scope: string,
  sessionId: string,
  options: {
    before?: MessageHistoryCursor | null;
    limit?: number;
  } = {},
): Promise<MessageHistoryPage> {
  if (!scope || !sessionId) {
    return { messages: [], cursor: null, hasMore: false };
  }
  const limit = Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE);
  const database = await openHistoryDatabase();
  try {
    const records = await new Promise<StoredChatMessage[]>(
      (resolve, reject) => {
        const transaction = database.transaction(MESSAGE_STORE, "readonly");
        const index = transaction
          .objectStore(MESSAGE_STORE)
          .index(BY_SESSION_INDEX);
        const lower = [scope, sessionId, 0, ""];
        const upper = options.before
          ? [
              scope,
              sessionId,
              options.before.timestamp,
              options.before.id,
            ]
          : [scope, sessionId, Number.MAX_SAFE_INTEGER, "\uffff"];
        const range = IDBKeyRange.bound(
          lower,
          upper,
          false,
          Boolean(options.before),
        );
        const request = index.openCursor(range, "prev");
        const result: StoredChatMessage[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || result.length > limit) return;
          result.push(cursor.value as StoredChatMessage);
          if (result.length <= limit) cursor.continue();
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () =>
          reject(
            transaction.error ??
              request.error ??
              new Error("Could not load the conversation history."),
          );
        transaction.onerror = () => {
          // onabort reports the final transaction error.
        };
      },
    );
    const hasMore = records.length > limit;
    const page = records.slice(0, limit).reverse();
    const messages = page.map((record) => {
      const message = structuredClone(record) as unknown as Record<
        string,
        unknown
      >;
      delete message.key;
      delete message.scope;
      delete message.sessionId;
      return message as PersistedChatMessage;
    });
    const oldest = messages[0];
    return {
      messages,
      cursor: oldest
        ? { timestamp: oldest.timestamp ?? 0, id: oldest.id }
        : options.before ?? null,
      hasMore,
    };
  } finally {
    database.close();
  }
}

export async function clearMessageHistoryScope(scope: string): Promise<void> {
  if (!scope) return;
  return enqueueHistoryWrite(async () => {
    const database = await openHistoryDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(MESSAGE_STORE, "readwrite");
        const index = transaction
          .objectStore(MESSAGE_STORE)
          .index(BY_SCOPE_INDEX);
        const request = index.openCursor(IDBKeyRange.only(scope));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(
            transaction.error ??
              request.error ??
              new Error("Could not clear the conversation history."),
          );
        transaction.onerror = () => {
          // onabort reports the final transaction error.
        };
      });
    } finally {
      database.close();
    }
  });
}

export async function clearSessionMessageHistory(
  scope: string,
  sessionId: string,
): Promise<void> {
  if (!scope || !sessionId) return;
  return enqueueHistoryWrite(async () => {
    const database = await openHistoryDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(MESSAGE_STORE, "readwrite");
        const index = transaction
          .objectStore(MESSAGE_STORE)
          .index(BY_SESSION_INDEX);
        const range = IDBKeyRange.bound(
          [scope, sessionId, 0, ""],
          [scope, sessionId, Number.MAX_SAFE_INTEGER, "\uffff"],
        );
        const request = index.openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(
            transaction.error ??
              request.error ??
              new Error("Could not clear this session's local history."),
          );
        transaction.onerror = () => {
          // onabort reports the final transaction error.
        };
      });
    } finally {
      database.close();
    }
  });
}

function historyMessageKey(scope: string, messageId: string): string {
  return `${scope}\u0000${messageId}`;
}

function storedChatMessage(
  scope: string,
  sessionId: string,
  message: PersistedChatMessage,
): StoredChatMessage {
  return {
    ...structuredClone(message),
    timestamp: message.timestamp ?? Date.now(),
    key: historyMessageKey(scope, message.id),
    scope,
    sessionId,
  };
}

function enqueueHistoryWrite(operation: () => Promise<void>): Promise<void> {
  const queued = historyWriteChain.then(operation);
  historyWriteChain = queued.catch(() => {
    // Keep later writes available after one failed transaction.
  });
  return queued;
}

function openHistoryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(MESSAGE_STORE)
        ? request.transaction!.objectStore(MESSAGE_STORE)
        : database.createObjectStore(MESSAGE_STORE, { keyPath: "key" });
      if (!store.indexNames.contains(BY_SESSION_INDEX)) {
        store.createIndex(
          BY_SESSION_INDEX,
          ["scope", "sessionId", "timestamp", "id"],
          { unique: false },
        );
      }
      if (!store.indexNames.contains(BY_SCOPE_INDEX)) {
        store.createIndex(BY_SCOPE_INDEX, "scope", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error("Could not open the conversation history database."),
      );
  });
}
