import assert from "node:assert/strict";
import test from "node:test";
import { shouldReconcileRecentHistory } from "../app/crossDeviceSync.ts";

test("a newer selected-session snapshot invalidates recent history", () => {
  assert.equal(
    shouldReconcileRecentHistory({
      selectedSessionId: "session-1",
      previousUpdatedAt: 10,
      nextUpdatedAt: 11,
    }),
    true,
  );
});

test("initial, unchanged, older, and unselected snapshots do not duplicate recovery", () => {
  assert.equal(
    shouldReconcileRecentHistory({
      selectedSessionId: "session-1",
      previousUpdatedAt: undefined,
      nextUpdatedAt: 11,
    }),
    false,
  );
  assert.equal(
    shouldReconcileRecentHistory({
      selectedSessionId: "session-1",
      previousUpdatedAt: 11,
      nextUpdatedAt: 11,
    }),
    false,
  );
  assert.equal(
    shouldReconcileRecentHistory({
      selectedSessionId: "session-1",
      previousUpdatedAt: 12,
      nextUpdatedAt: 11,
    }),
    false,
  );
  assert.equal(
    shouldReconcileRecentHistory({
      selectedSessionId: null,
      previousUpdatedAt: 10,
      nextUpdatedAt: 11,
    }),
    false,
  );
});
