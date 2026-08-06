import type { MatrixConnectionStatus } from "./matrix";

export type ConnectionPresentation = {
  state: "progress" | "ready" | "offline" | "blocked";
  title: string;
  detail: string;
  /** Diagnostic-only code. Rendering code must not use this as visible copy. */
  rawDetailCode?: string;
};

type DetailCopy = Pick<ConnectionPresentation, "title" | "detail">;

const NATIVE_DETAIL_COPY: Readonly<Record<string, DetailCopy>> = {
  native_stopped: {
    title: "Connection paused",
    detail: "Open Codever to resume the native connection.",
  },
  matrix_session_required: {
    title: "Gateway setup required",
    detail: "Pair this device with a Gateway to continue.",
  },
  matrix_session_restoring: {
    title: "Restoring secure session",
    detail: "Loading the saved Matrix session on this device…",
  },
  matrix_token_exchange: {
    title: "Signing in securely",
    detail: "Completing the one-time Matrix sign-in…",
  },
  matrix_driver_starting: {
    title: "Starting secure connection",
    detail: "Preparing the native Matrix connection…",
  },
  matrix_first_sync_waiting: {
    title: "Connecting for the first time",
    detail: "Waiting for the first encrypted Matrix sync…",
  },
  matrix_sync_active: {
    title: "Securely connected",
    detail: "Gateway messages and session state are up to date.",
  },
  matrix_sync_connecting: {
    title: "Connecting securely",
    detail: "Starting the encrypted Matrix sync…",
  },
  matrix_sync_reconnecting: {
    title: "Reconnecting securely",
    detail: "Codever will resume automatically when Matrix is reachable.",
  },
  matrix_sync_retry_wait: {
    title: "Connection interrupted",
    detail: "Retrying the secure Matrix connection automatically…",
  },
  network_unavailable: {
    title: "You’re offline",
    detail: "Your conversations remain available and syncing will resume automatically.",
  },
  matrix_login_retryable: {
    title: "Sign-in interrupted",
    detail: "Codever will retry the Matrix sign-in automatically.",
  },
  matrix_login_rejected: {
    title: "Matrix sign-in was rejected",
    detail: "Pair this device again with a fresh invitation.",
  },
  matrix_recovery_blocked: {
    title: "Secure session needs attention",
    detail: "Open Gateway settings and repair or pair this device again.",
  },
  matrix_sync_service_build_failed: {
    title: "Native Matrix service could not start",
    detail: "Update Codever or export diagnostics for support.",
  },
  matrix_sdk_internal_failure: {
    title: "Native Matrix service needs attention",
    detail: "Restart Codever. If this continues, export diagnostics for support.",
  },
  matrix_runtime_failed: {
    title: "Secure connection was interrupted",
    detail: "Codever is retrying automatically.",
  },
  matrix_storage_failed: {
    title: "Encrypted storage is unavailable",
    detail: "Restart Codever. If this continues, repair the device connection.",
  },
  matrix_first_sync_timeout: {
    title: "First secure sync did not finish",
    detail: "Check the server connection, then restart Codever or export diagnostics.",
  },
  matrix_sync_task_stopped: {
    title: "Secure sync stopped",
    detail: "Codever is restarting the Matrix connection automatically.",
  },
  matrix_sync_stale: {
    title: "Secure sync is behind",
    detail: "Codever is refreshing the Matrix connection automatically.",
  },
  matrix_send_queue_resume_failed: {
    title: "Queued messages are waiting",
    detail: "Codever is reconnecting before it resumes sending.",
  },
  matrix_driver_create_failed: {
    title: "Native Matrix connection could not start",
    detail: "Codever will retry. Export diagnostics if this continues.",
  },
  matrix_driver_start_timeout: {
    title: "Native Matrix connection is taking too long",
    detail: "Codever will retry. Check the server connection if this continues.",
  },
  matrix_restore_or_sync_failed: {
    title: "Secure session could not be restored",
    detail: "Codever will retry. Export diagnostics if this continues.",
  },
  matrix_application_control_sync_rejected: {
    title: "Secure sync could not resume",
    detail: "Restart Codever. If this continues, export diagnostics for support.",
  },
};

const DEFAULT_COPY: Record<MatrixConnectionStatus, DetailCopy> = {
  connecting: {
    title: "Connecting securely",
    detail: "Preparing the Matrix connection…",
  },
  securing: {
    title: "Verifying Gateway",
    detail: "Checking this Gateway’s trusted identity…",
  },
  connected: {
    title: "Securely connected",
    detail: "Gateway messages and session state are up to date.",
  },
  reconnecting: {
    title: "Reconnecting securely",
    detail: "Codever will resume automatically when Matrix is reachable.",
  },
  offline: {
    title: "You’re offline",
    detail: "Your conversations remain available and syncing will resume automatically.",
  },
  error: {
    title: "Connection needs attention",
    detail: "Open Gateway settings to inspect or repair the connection.",
  },
};

export function deriveConnectionPresentation(
  status: MatrixConnectionStatus,
  detail?: string | null,
): ConnectionPresentation {
  const trimmedDetail = detail?.trim();
  const machineCode = trimmedDetail && isMachineDetailCode(trimmedDetail)
    ? trimmedDetail
    : undefined;
  const mappedCopy = machineCode === undefined
    ? undefined
    : NATIVE_DETAIL_COPY[machineCode];
  const copy = mappedCopy ??
    DEFAULT_COPY[status];
  return {
    state: connectionPresentationState(status),
    title: copy.title,
    detail: machineCode ? copy.detail : trimmedDetail || copy.detail,
    ...(machineCode ? { rawDetailCode: machineCode } : {}),
  };
}

function connectionPresentationState(
  status: MatrixConnectionStatus,
): ConnectionPresentation["state"] {
  if (status === "connected") return "ready";
  if (status === "offline") return "offline";
  if (status === "error") return "blocked";
  return "progress";
}

function isMachineDetailCode(value: string): boolean {
  return /^(?:matrix|native|network)_[a-z0-9_]+$/.test(value);
}
