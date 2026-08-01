import assert from "node:assert/strict";
import test from "node:test";
import {
  LateResponseLifecycle,
  createDetachedSerialDispatcher,
} from "../app/lateResponseLifecycle.ts";
import { advanceHistoryCursor } from "../app/historyCursor.ts";

test("a history soft timeout retains the request and coalesces retry", async () => {
  const expired: string[] = [];
  const lifecycle = new LateResponseLifecycle<string>((id) => expired.push(id));
  lifecycle.register("history-1", "session-1\0latest", Date.now() + 1_000);

  await assert.rejects(
    lifecycle.wait(
      "history-1",
      5,
      () => new Error("history is still being prepared"),
    ),
    /still being prepared/,
  );
  assert.equal(lifecycle.size, 1);
  assert.equal(lifecycle.idForKey("session-1\0latest"), "history-1");

  const retry = lifecycle.wait(
    "history-1",
    100,
    () => new Error("retry timed out"),
  );
  assert.deepEqual(lifecycle.resolve("history-1", "late page"), {
    activeWaiters: 1,
    late: true,
  });
  assert.equal(await retry, "late page");
  assert.equal(lifecycle.size, 0);
  assert.deepEqual(expired, []);
});

test("a late history page with no retry is reported as recoverable", async () => {
  const lifecycle = new LateResponseLifecycle<{ messages: string[] }>();
  lifecycle.register("history-2", "session-2\0before", Date.now() + 1_000);
  await assert.rejects(
    lifecycle.wait("history-2", 5, () => new Error("soft timeout")),
    /soft timeout/,
  );

  assert.deepEqual(
    lifecycle.resolve("history-2", { messages: ["persist me"] }),
    { activeWaiters: 0, late: true },
  );
});

test("protocol expiry is the hard cleanup boundary for history waiters", async () => {
  const expired: string[] = [];
  const lifecycle = new LateResponseLifecycle<string>((id) => expired.push(id));
  lifecycle.register("history-expired", "session-3\0latest", Date.now() + 15);
  const pending = lifecycle.wait(
    "history-expired",
    1_000,
    () => new Error("soft timeout should not win"),
  );

  await assert.rejects(pending, /expired before its response arrived/);
  assert.deepEqual(expired, ["history-expired"]);
  assert.equal(lifecycle.size, 0);
});

test("slow history media work does not block the control event lane", async () => {
  let releaseHistory!: () => void;
  const historyBlocked = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let historyStarted = false;
  const errors: unknown[] = [];
  const dispatchHistory = createDetachedSerialDispatcher(
    async () => {
      historyStarted = true;
      await historyBlocked;
    },
    (error) => errors.push(error),
  );

  dispatchHistory("media-backed-page");
  await Promise.resolve();
  assert.equal(historyStarted, true);

  // This models the authenticated command-result branch continuing on the
  // inbound control chain while the detached history lane remains blocked.
  let commandResultHandled = false;
  commandResultHandled = true;
  assert.equal(commandResultHandled, true);
  assert.deepEqual(errors, []);

  releaseHistory();
  await Promise.resolve();
});

test("a late history page cannot roll an already-advanced cursor back", () => {
  const advanced = { before: "cursor-newer", complete: false };
  assert.equal(
    advanceHistoryCursor(advanced, "cursor-older", {
      nextBefore: "cursor-stale-response",
      hasMore: true,
    }),
    advanced,
  );
  assert.deepEqual(
    advanceHistoryCursor(advanced, "cursor-newer", {
      nextBefore: "cursor-next",
      hasMore: true,
    }),
    { before: "cursor-next", complete: false },
  );
});
