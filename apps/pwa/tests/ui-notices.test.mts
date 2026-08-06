import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_UI_NOTICE_STATE,
  noticesForScope,
  reduceUiNotices,
  shouldShowGlobalNotice,
} from "../app/uiNotices.ts";

test("scopes preserve unrelated operation notices", () => {
  const connection = reduceUiNotices(EMPTY_UI_NOTICE_STATE, {
    type: "show",
    key: "connection:matrix",
    scope: "connection",
    severity: "error",
    message: "  Repair the connection.  ",
    now: 100,
  });
  const withAttachment = reduceUiNotices(connection, {
    type: "show",
    key: "attachment:upload",
    scope: "attachment",
    severity: "error",
    message: "Upload failed.",
    now: 101,
  });

  assert.equal(Object.keys(withAttachment).length, 2);
  assert.equal(withAttachment["connection:matrix"].message, "Repair the connection.");
  assert.equal(noticesForScope(withAttachment, "attachment").length, 1);
  assert.equal(shouldShowGlobalNotice(withAttachment["connection:matrix"]), true);
  assert.equal(shouldShowGlobalNotice(withAttachment["attachment:upload"]), false);
});

test("info and success expire while warnings and errors remain actionable", () => {
  let state = reduceUiNotices(EMPTY_UI_NOTICE_STATE, {
    type: "show",
    key: "session:created",
    scope: "session",
    severity: "success",
    message: "Session created.",
    now: 1_000,
  });
  state = reduceUiNotices(state, {
    type: "show",
    key: "history:loading",
    scope: "history",
    severity: "info",
    message: "Loading history…",
    now: 1_000,
  });
  state = reduceUiNotices(state, {
    type: "show",
    key: "connection:offline",
    scope: "connection",
    severity: "warning",
    message: "Offline.",
    now: 1_000,
  });

  state = reduceUiNotices(state, { type: "tick", now: 5_000 });
  assert.equal(state["session:created"], undefined);
  assert.ok(state["history:loading"]);
  assert.ok(state["connection:offline"]);
  state = reduceUiNotices(state, { type: "tick", now: 7_000 });
  assert.equal(state["history:loading"], undefined);
  assert.ok(state["connection:offline"]);
});

test("recovery clears only the recovered operation or scope", () => {
  let state = reduceUiNotices(EMPTY_UI_NOTICE_STATE, {
    type: "show",
    key: "session:delete:a",
    scope: "session",
    severity: "error",
    message: "Delete failed.",
    now: 1,
  });
  state = reduceUiNotices(state, {
    type: "show",
    key: "session:create",
    scope: "session",
    severity: "error",
    message: "Create failed.",
    now: 2,
  });
  state = reduceUiNotices(state, {
    type: "show",
    key: "connection:matrix",
    scope: "connection",
    severity: "error",
    message: "Connection failed.",
    now: 3,
  });

  state = reduceUiNotices(state, {
    type: "operation-recovered",
    key: "session:delete:a",
  });
  assert.equal(state["session:delete:a"], undefined);
  assert.ok(state["session:create"]);

  state = reduceUiNotices(state, { type: "scope-recovered", scope: "session" });
  assert.equal(state["session:create"], undefined);
  assert.ok(state["connection:matrix"]);

  state = reduceUiNotices(state, { type: "scope-recovered", scope: "connection" });
  assert.deepEqual(state, {});
});

test("showing the same operation replaces stale copy and resets its lifetime", () => {
  const first = reduceUiNotices(EMPTY_UI_NOTICE_STATE, {
    type: "show",
    key: "composer:send",
    scope: "composer",
    severity: "info",
    message: "Sending…",
    now: 10,
  });
  const next = reduceUiNotices(first, {
    type: "show",
    key: "composer:send",
    scope: "composer",
    severity: "error",
    message: "Could not send.",
    now: 20,
  });
  assert.equal(Object.keys(next).length, 1);
  assert.equal(next["composer:send"].severity, "error");
  assert.equal(next["composer:send"].expiresAt, null);

  assert.deepEqual(
    reduceUiNotices(next, { type: "dismiss", key: "composer:send" }),
    {},
  );
});
