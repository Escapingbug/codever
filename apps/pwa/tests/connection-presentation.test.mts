import assert from "node:assert/strict";
import test from "node:test";
import { deriveConnectionPresentation } from "../app/connectionPresentation.ts";

test("maps native progress codes to calm user-facing copy while retaining diagnostics", () => {
  const presentation = deriveConnectionPresentation(
    "connecting",
    "matrix_first_sync_waiting",
  );
  assert.deepEqual(presentation, {
    state: "progress",
    title: "Connecting for the first time",
    detail: "Waiting for the first encrypted Matrix sync…",
    rawDetailCode: "matrix_first_sync_waiting",
  });
  assert.equal(presentation.detail.includes("matrix_"), false);
});

test("maps legacy native sync progress without exposing the machine code", () => {
  const presentation = deriveConnectionPresentation(
    "connecting",
    "matrix_sync_connecting",
  );
  assert.equal(presentation.title, "Connecting securely");
  assert.equal(presentation.detail, "Starting the encrypted Matrix sync…");
  assert.equal(presentation.rawDetailCode, "matrix_sync_connecting");
});

test("blocked native codes provide actionable copy instead of leaking raw codes", () => {
  const presentation = deriveConnectionPresentation(
    "error",
    "matrix_sdk_internal_failure",
  );
  assert.equal(presentation.state, "blocked");
  assert.equal(presentation.title, "Native Matrix service needs attention");
  assert.equal(presentation.rawDetailCode, "matrix_sdk_internal_failure");
  assert.equal(presentation.detail.includes("matrix_sdk_internal_failure"), false);
});

test("unknown machine codes remain diagnostic-only and use status fallback copy", () => {
  const presentation = deriveConnectionPresentation(
    "reconnecting",
    "matrix_future_retry_reason",
  );
  assert.deepEqual(presentation, {
    state: "progress",
    title: "Reconnecting securely",
    detail: "Codever will resume automatically when Matrix is reachable.",
    rawDetailCode: "matrix_future_retry_reason",
  });
});

test("human web-runtime details remain visible and statuses have stable severity", () => {
  assert.deepEqual(
    deriveConnectionPresentation("securing", "Verifying the trusted Gateway device…"),
    {
      state: "progress",
      title: "Verifying Gateway",
      detail: "Verifying the trusted Gateway device…",
    },
  );
  assert.equal(deriveConnectionPresentation("connected").state, "ready");
  assert.equal(deriveConnectionPresentation("offline").state, "offline");
  assert.equal(deriveConnectionPresentation("error").state, "blocked");
});
