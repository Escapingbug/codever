import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPendingSessionCreateRecovery,
  completedSessionCreateTarget,
  isMissingSessionCreateRecoveryCommand,
  readPendingSessionCreateRecovery,
  sessionCreateRecoveryMatches,
  writePendingSessionCreateRecovery,
  type PendingSessionCreateRecovery,
} from "../app/sessionCreateRecovery.ts";
import { CommandRecoveryNotFoundError } from "../app/matrix.ts";

test("does not leave a pending selection when the session root arrives first", () => {
  assert.deepEqual(
    completedSessionCreateTarget("session-new", new Set(["session-new"])),
    {
      pendingSessionId: null,
      sessionToReveal: "session-new",
      skipHistoryRestore: true,
    },
  );
});

test("waits for the session root when the command result arrives first", () => {
  assert.deepEqual(
    completedSessionCreateTarget("session-new", new Set()),
    {
      pendingSessionId: "session-new",
      sessionToReveal: null,
      skipHistoryRestore: true,
    },
  );
});

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const recovery: PendingSessionCreateRecovery = {
  version: 1,
  commandId: "command-create-1",
  gatewayId: "gateway-1",
  conversationId: "room-1",
  createdAt: 1_785_000_000_000,
  input: {
    cwd: "/workspace/codever",
    projectName: "Codever",
    model: "gpt-5",
    reasoningEffort: "high",
    extensions: [],
  },
};

test("persists the durable session-create identity across a reload", () => {
  const storage = new MemoryStorage();
  writePendingSessionCreateRecovery(storage, recovery);

  assert.deepEqual(readPendingSessionCreateRecovery(storage), recovery);
  assert.equal(
    sessionCreateRecoveryMatches(recovery, {
      gatewayId: "gateway-1",
      conversationId: "room-1",
    }),
    true,
  );
  assert.equal(
    sessionCreateRecoveryMatches(recovery, {
      gatewayId: "gateway-2",
      conversationId: "room-1",
    }),
    false,
  );
});

test("only the matching command may clear a newer recovery record", () => {
  const storage = new MemoryStorage();
  writePendingSessionCreateRecovery(storage, recovery);

  assert.equal(
    clearPendingSessionCreateRecovery(storage, "older-command"),
    false,
  );
  assert.deepEqual(readPendingSessionCreateRecovery(storage), recovery);

  assert.equal(
    clearPendingSessionCreateRecovery(storage, recovery.commandId),
    true,
  );
  assert.equal(readPendingSessionCreateRecovery(storage), null);
});

test("rejects malformed recovery records instead of replaying them", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    "codever:pending-session-create:v1",
    JSON.stringify({ ...recovery, commandId: "", input: { cwd: 7 } }),
  );

  assert.equal(readPendingSessionCreateRecovery(storage), null);
});

test("treats unavailable browser storage as no recoverable command", () => {
  const unavailable = {
    getItem(): string | null {
      throw new Error("storage unavailable");
    },
    setItem(): void {
      throw new Error("storage unavailable");
    },
    removeItem(): void {
      throw new Error("storage unavailable");
    },
  };

  assert.equal(readPendingSessionCreateRecovery(unavailable), null);
  assert.throws(
    () => writePendingSessionCreateRecovery(unavailable, recovery),
    /storage unavailable/,
  );
});

test("stops restoring a local create marker when the native command no longer exists", () => {
  assert.equal(
    isMissingSessionCreateRecoveryCommand({ errorCode: "OPERATION_NOT_FOUND" }),
    true,
  );
  assert.equal(
    isMissingSessionCreateRecoveryCommand({ errorCode: "OFFLINE" }),
    false,
  );
  assert.equal(isMissingSessionCreateRecoveryCommand(new Error("missing")), false);
});

test("stops restoring an old browser marker when its durable command no longer exists", () => {
  const error = new CommandRecoveryNotFoundError("old-command");

  assert.equal(error.errorCode, "OPERATION_NOT_FOUND");
  assert.equal(isMissingSessionCreateRecoveryCommand(error), true);
});
