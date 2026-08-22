import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionRepairReasonForDetail,
  connectionStatusForBrowserNetwork,
  deriveConnectionRecoveryPlan,
  deriveConnectionPresentation,
  deriveMobileConnectionSignal,
} from "../app/connectionPresentation.ts";

test("generic failures provide direct recovery actions instead of pointing back to settings", () => {
  const presentation = deriveConnectionPresentation("error");
  assert.doesNotMatch(presentation.detail, /open connection settings/i);
  assert.deepEqual(
    deriveConnectionRecoveryPlan({
      status: "error",
      detail: null,
      hasSavedConnection: true,
    }),
    {
      title: "Recover this device",
      detail:
        "Retry the saved connection first. If this screen returns, repair only this device with a new one-time invitation; server conversation history is preserved.",
      primary: { action: "retry", label: "Retry connection" },
      secondary: {
        action: "new-invitation",
        label: "Use a new invitation",
      },
    },
  );
});

test("incomplete setup leads directly to a new invitation", () => {
  const recovery = deriveConnectionRecoveryPlan({
    status: "error",
    detail: null,
    hasSavedConnection: false,
  });
  assert.equal(recovery?.primary.action, "new-invitation");
  assert.equal(recovery?.secondary?.action, "export-diagnostics");
});

test("cache recovery retries without discarding saved trust", () => {
  const recovery = deriveConnectionRecoveryPlan({
    status: "error",
    detail: "matrix_projection_repair_required",
    hasSavedConnection: true,
  });
  assert.equal(recovery?.primary.action, "retry");
  assert.equal(recovery?.secondary?.action, "export-diagnostics");
  assert.doesNotMatch(recovery?.detail ?? "", /invitation/i);
});

test("authorization failures do not offer a retry that cannot repair them", () => {
  const recovery = deriveConnectionRecoveryPlan({
    status: "error",
    detail: "matrix_project_authorization_repair_required",
    hasSavedConnection: true,
  });
  assert.equal(recovery?.primary.action, "new-invitation");
  assert.equal(recovery?.secondary?.action, "export-diagnostics");
});

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

test("an unrecoverably large Matrix baseline is visible instead of syncing forever", () => {
  const presentation = deriveConnectionPresentation(
    "error",
    "matrix_application_control_baseline_too_large",
  );
  assert.equal(presentation.state, "blocked");
  assert.equal(presentation.title, "Conversation sync needs attention");
  assert.match(presentation.detail, /export diagnostics/i);
  assert.equal(
    presentation.detail.includes("matrix_application_control_baseline_too_large"),
    false,
  );
});

test("an oversized incremental response retains the last verified cursor", () => {
  const presentation = deriveConnectionPresentation(
    "error",
    "matrix_application_control_incremental_too_large",
  );
  assert.equal(presentation.state, "blocked");
  assert.equal(presentation.title, "Conversation sync needs attention");
  assert.match(presentation.detail, /last verified position was retained/i);
});

test("CVP3 recovery failures retain a stable diagnostic stage", () => {
  const presentation = deriveConnectionPresentation(
    "error",
    "matrix_gateway_state_recovery_failed",
  );
  assert.equal(presentation.title, "Conversation sync needs attention");
  assert.match(presentation.detail, /export diagnostics/i);
  assert.equal(
    presentation.rawDetailCode,
    "matrix_gateway_state_recovery_failed",
  );
});

test("missing native session with retained trust is presented as a repairable state", () => {
  const presentation = deriveConnectionPresentation(
    "error",
    "matrix_session_repair_required",
  );
  assert.equal(presentation.state, "blocked");
  assert.equal(presentation.title, "Connection repair required");
  assert.match(presentation.detail, /local sign-in is missing/i);
  assert.match(presentation.detail, /new invitation/i);
});

test("stale project authorization directs the user to reauthorize without retry copy", () => {
  const presentation = deriveConnectionPresentation(
    "error",
    "matrix_project_authorization_repair_required",
  );
  assert.equal(presentation.title, "Device authorization required");
  assert.match(presentation.detail, /new one-time invitation/i);
  assert.match(presentation.detail, /will not be deleted/i);
  assert.doesNotMatch(presentation.detail, /try again|retry/i);
  assert.equal(
    connectionRepairReasonForDetail(presentation.rawDetailCode),
    "project-authorization",
  );
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

test("collapses mobile connection sub-phases into stable product signals", () => {
  assert.deepEqual(
    deriveMobileConnectionSignal({
      trusted: false,
      status: "offline",
      gatewayAvailable: false,
    }),
    { state: "setup", label: "Connect" },
  );
  for (const status of ["connecting", "securing", "reconnecting"] as const) {
    assert.deepEqual(
      deriveMobileConnectionSignal({
        trusted: true,
        status,
        gatewayAvailable: false,
      }),
      { state: "progress", label: "Connecting" },
    );
  }
  assert.deepEqual(
    deriveMobileConnectionSignal({
      trusted: true,
      status: "connected",
      gatewayAvailable: true,
    }),
    { state: "ready", label: "Online" },
  );
  assert.deepEqual(
    deriveMobileConnectionSignal({
      trusted: true,
      status: "offline",
      gatewayAvailable: false,
    }),
    { state: "offline", label: "Offline" },
  );
  assert.deepEqual(
    deriveMobileConnectionSignal({
      trusted: true,
      status: "error",
      gatewayAvailable: false,
    }),
    { state: "attention", label: "Attention" },
  );
});
