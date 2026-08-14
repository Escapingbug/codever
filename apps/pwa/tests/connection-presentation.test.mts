import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionStatusForBrowserNetwork,
  deriveConnectionPresentation,
} from "../app/connectionPresentation.ts";

test("maps native progress codes to calm user-facing copy while retaining diagnostics", () => {
  const presentation = deriveConnectionPresentation(
    "connecting",
    "matrix_first_sync_waiting",
  );
  assert.deepEqual(presentation, {
    state: "progress",
    title: "Finishing setup",
    detail: "Downloading your latest conversations…",
    rawDetailCode: "matrix_first_sync_waiting",
  });
  assert.equal(presentation.detail.includes("matrix_"), false);
});

test("keeps the connection in progress until Gateway state is authoritative", () => {
  const presentation = deriveConnectionPresentation(
    "connecting",
    "matrix_gateway_state_syncing",
  );
  assert.equal(presentation.state, "progress");
  assert.equal(presentation.title, "Syncing conversations");
  assert.equal(presentation.detail, "Checking your latest Gateway state…");
  assert.equal(presentation.rawDetailCode, "matrix_gateway_state_syncing");
});

test("blocked native codes provide actionable copy instead of leaking raw codes", () => {
  const presentation = deriveConnectionPresentation(
    "error",
    "matrix_sdk_internal_failure",
  );
  assert.equal(presentation.state, "blocked");
  assert.equal(presentation.title, "Background connection needs attention");
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
    title: "Reconnecting",
    detail: "Codever will resume automatically when the connection returns.",
    rawDetailCode: "matrix_future_retry_reason",
  });
});

test("runtime details remain diagnostic-only and statuses have stable severity", () => {
  assert.deepEqual(
    deriveConnectionPresentation("securing", "Verifying the trusted Gateway device…"),
    {
      state: "progress",
      title: "Checking connection",
      detail: "Confirming your approved computer…",
      diagnosticDetail: "Verifying the trusted Gateway device…",
    },
  );
  assert.equal(deriveConnectionPresentation("connected").state, "ready");
  assert.equal(deriveConnectionPresentation("offline").state, "offline");
  assert.equal(deriveConnectionPresentation("error").state, "blocked");
});

test("reports browser transport phases as offline when the browser knows it has no network", () => {
  for (const status of ["connecting", "securing", "connected", "reconnecting"] as const) {
    assert.equal(connectionStatusForBrowserNetwork(status, false), "offline");
  }
  assert.equal(connectionStatusForBrowserNetwork("connected", true), "connected");
  assert.equal(connectionStatusForBrowserNetwork("error", false), "error");
});
