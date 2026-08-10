import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldReconcileRecentHistory,
  shouldRecoverVisibleHistory,
} from "../app/crossDeviceSync.ts";

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

test("foreground, focus, and online recovery is bounded but does not need a newer snapshot", () => {
  assert.equal(
    shouldRecoverVisibleHistory({
      visible: true,
      connected: true,
      selectedSessionId: "session-1",
      lastRecoveryAt: 1_000,
      now: 3_000,
    }),
    true,
  );
  assert.equal(
    shouldRecoverVisibleHistory({
      visible: true,
      connected: true,
      selectedSessionId: "session-1",
      lastRecoveryAt: 2_500,
      now: 3_000,
    }),
    false,
  );
  assert.equal(
    shouldRecoverVisibleHistory({
      visible: false,
      connected: true,
      selectedSessionId: "session-1",
      lastRecoveryAt: 0,
      now: 3_000,
    }),
    false,
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
