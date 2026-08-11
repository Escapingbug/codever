import assert from "node:assert/strict";
import test from "node:test";
import {
  readSelectedSession,
  selectedSessionStorageKey,
  writeSelectedSession,
} from "../app/selectedSessionState.ts";

test("persists the selected conversation independently for each Gateway scope", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };

  assert.equal(writeSelectedSession(storage, "gateway-a\0room-a", "session-a"), true);
  assert.equal(writeSelectedSession(storage, "gateway-b\0room-b", "session-b"), true);
  assert.equal(readSelectedSession(storage, "gateway-a\0room-a"), "session-a");
  assert.equal(readSelectedSession(storage, "gateway-b\0room-b"), "session-b");
  assert.notEqual(
    selectedSessionStorageKey("gateway-a\0room-a"),
    selectedSessionStorageKey("gateway-b\0room-b"),
  );
});

test("clears deleted selections and ignores unavailable storage", () => {
  let stored: string | null = "session-a";
  const storage = {
    getItem() {
      return stored;
    },
    setItem(_key: string, value: string) {
      stored = value;
    },
    removeItem() {
      stored = null;
    },
  };

  assert.equal(writeSelectedSession(storage, "scope", null), true);
  assert.equal(readSelectedSession(storage, "scope"), null);
  assert.equal(writeSelectedSession(undefined, "scope", "session-a"), false);
  assert.equal(readSelectedSession(undefined, "scope"), null);
});

test("storage failures and invalid persisted ids do not break startup", () => {
  const blocked = {
    getItem(): string | null {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem(): void {
      throw new DOMException("blocked", "SecurityError");
    },
    removeItem(): void {
      throw new DOMException("blocked", "SecurityError");
    },
  };

  assert.equal(readSelectedSession(blocked, "scope"), null);
  assert.equal(writeSelectedSession(blocked, "scope", "session-a"), false);
  assert.equal(readSelectedSession({ getItem: () => "x".repeat(513) }, "scope"), null);
});
