export type ConnectionRecoveryDisposition =
  | "automatic"
  | "reauthorize"
  | "update"
  | "restart"
  | "diagnostics"
  | "unsupported";

const REAUTHORIZE_DETAILS = new Set([
  "matrix_login_rejected",
  "matrix_project_authorization_repair_required",
  "matrix_session_repair_required",
]);

const UPDATE_DETAILS = new Set([
  "matrix_native_runtime_outdated",
  "matrix_sync_service_build_failed",
]);

const RESTART_DETAILS = new Set([
  "matrix_native_runtime_unavailable",
]);

const INTEGRITY_DETAILS = new Set([
  "matrix_application_control_baseline_too_large",
  "matrix_application_control_incremental_too_large",
  "matrix_application_control_sync_rejected",
  "matrix_event_ingest_failed",
]);

/**
 * Only conditions that cannot be repaired without changing authorization,
 * software, or inspecting an integrity failure may interrupt the user.
 * Everything else is owned by the connection supervisor.
 */
export function connectionRecoveryDisposition(
  detail?: string | null,
): ConnectionRecoveryDisposition {
  const code = detail?.trim() ?? "";
  if (REAUTHORIZE_DETAILS.has(code)) return "reauthorize";
  if (UPDATE_DETAILS.has(code)) return "update";
  if (RESTART_DETAILS.has(code)) return "restart";
  if (INTEGRITY_DETAILS.has(code)) return "diagnostics";
  if (code === "matrix_web_locks_unavailable") return "unsupported";
  return "automatic";
}

const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** Exponential startup retry capped at 30 seconds; recovery never gives up. */
export function automaticConnectionRetryDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), RETRY_DELAYS_MS.length - 1));
  return RETRY_DELAYS_MS[index];
}
