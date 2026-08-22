import type { MatrixConnectionStatus } from "./matrix";

export type ConnectionPresentation = {
  state: "progress" | "ready" | "offline" | "blocked";
  title: string;
  detail: string;
  /** Diagnostic-only code. Rendering code must not use this as visible copy. */
  rawDetailCode?: string;
  /** Diagnostic-only runtime detail. Rendering code must not use this as visible copy. */
  diagnosticDetail?: string;
};

export type ConnectionRepairReason =
  | "matrix-session"
  | "project-authorization";

export type MobileConnectionSignal = {
  state: "setup" | "progress" | "ready" | "offline" | "attention";
  label: "Connect" | "Connecting" | "Online" | "Offline" | "Attention";
};

type DetailCopy = Pick<ConnectionPresentation, "title" | "detail">;

const NATIVE_DETAIL_COPY: Readonly<Record<string, DetailCopy>> = {
  native_stopped: {
    title: "Connection paused",
    detail: "Open Codever to resume the native connection.",
  },
  matrix_session_required: {
    title: "Setup required",
    detail: "Connect this device to your computer to continue.",
  },
  matrix_session_repair_required: {
    title: "Connection repair required",
    detail:
      "This device still trusts your computer, but its local sign-in is missing. Use a new invitation from that computer to repair it.",
  },
  matrix_project_authorization_repair_required: {
    title: "Device authorization required",
    detail:
      "This device’s saved authorization no longer matches your computer. Reauthorize it with a new one-time invitation; your server conversation history will not be deleted.",
  },
  matrix_session_restoring: {
    title: "Restoring connection",
    detail: "Loading the saved secure connection…",
  },
  matrix_token_exchange: {
    title: "Signing in",
    detail: "Completing the one-time sign-in…",
  },
  matrix_driver_starting: {
    title: "Starting connection",
    detail: "Preparing the background connection…",
  },
  matrix_first_sync_waiting: {
    title: "Finishing setup",
    detail: "Downloading your latest conversations…",
  },
  matrix_gateway_state_syncing: {
    title: "Syncing conversations",
    detail: "Checking your latest Gateway state…",
  },
  matrix_gateway_offline: {
    title: "Computer offline",
    detail:
      "This device can reach Matrix, but your Codever Gateway has not checked in. Start Codever on the computer to continue.",
  },
  matrix_sync_active: {
    title: "Connected",
    detail: "Messages and conversations are up to date.",
  },
  matrix_sync_reconnecting: {
    title: "Reconnecting",
    detail: "Codever will resume automatically when the connection returns.",
  },
  matrix_sync_retry_wait: {
    title: "Connection interrupted",
    detail: "Trying again automatically…",
  },
  network_unavailable: {
    title: "You’re offline",
    detail: "Your conversations remain available and syncing will resume automatically.",
  },
  matrix_login_retryable: {
    title: "Sign-in interrupted",
    detail: "Codever will try signing in again automatically.",
  },
  matrix_login_rejected: {
    title: "Sign-in failed",
    detail: "Add this device again with a new invitation.",
  },
  matrix_recovery_blocked: {
    title: "Connection needs attention",
    detail: "Open connection settings to repair or add this device again.",
  },
  matrix_sync_service_build_failed: {
    title: "Background connection could not start",
    detail: "Update Codever or export diagnostics for support.",
  },
  matrix_sdk_internal_failure: {
    title: "Background connection needs attention",
    detail: "Restart Codever. If this continues, export diagnostics for support.",
  },
  matrix_runtime_failed: {
    title: "Connection was interrupted",
    detail: "Codever is retrying automatically.",
  },
  matrix_storage_failed: {
    title: "Local storage is unavailable",
    detail: "Restart Codever. If this continues, repair the device connection.",
  },
  matrix_first_sync_timeout: {
    title: "Setup is taking too long",
    detail: "Check the connection, then restart Codever or export diagnostics.",
  },
  matrix_sync_task_stopped: {
    title: "Connection paused",
    detail: "Codever is restarting the connection automatically.",
  },
  matrix_sync_stale: {
    title: "Updates are delayed",
    detail: "Codever is refreshing the connection automatically.",
  },
  matrix_send_queue_resume_failed: {
    title: "Queued messages are waiting",
    detail: "Codever is reconnecting before it resumes sending.",
  },
  matrix_driver_create_failed: {
    title: "Background connection could not start",
    detail: "Codever will retry. Export diagnostics if this continues.",
  },
  matrix_driver_start_timeout: {
    title: "Connection is taking too long",
    detail: "Codever will retry. Check the server connection if this continues.",
  },
  matrix_restore_or_sync_failed: {
    title: "Connection could not be restored",
    detail: "Codever will retry. Export diagnostics if this continues.",
  },
  matrix_application_control_sync_rejected: {
    title: "Connection could not resume",
    detail: "Restart Codever. If this continues, export diagnostics for support.",
  },
  matrix_application_control_baseline_too_large: {
    title: "Conversation sync needs attention",
    detail:
      "The Matrix server returned more current state than this client can safely process. Export diagnostics for support.",
  },
  matrix_application_control_incremental_too_large: {
    title: "Conversation sync needs attention",
    detail:
      "The Matrix server returned an invalid oversized update. Your last verified position was retained; restart Codever or export diagnostics if this continues.",
  },
};

const DEFAULT_COPY: Record<MatrixConnectionStatus, DetailCopy> = {
  connecting: {
    title: "Connecting",
    detail: "Preparing your connection…",
  },
  securing: {
    title: "Checking connection",
    detail: "Confirming your approved computer…",
  },
  connected: {
    title: "Connected",
    detail: "Messages and conversations are up to date.",
  },
  reconnecting: {
    title: "Reconnecting",
    detail: "Codever will resume automatically when the connection returns.",
  },
  offline: {
    title: "You’re offline",
    detail: "Your conversations remain available and syncing will resume automatically.",
  },
  error: {
    title: "Connection needs attention",
    detail: "Open connection settings to inspect or repair it.",
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
    detail: copy.detail,
    ...(machineCode ? { rawDetailCode: machineCode } : {}),
    ...(!machineCode && trimmedDetail
      ? { diagnosticDetail: trimmedDetail }
      : {}),
  };
}

export function connectionStatusForBrowserNetwork(
  status: MatrixConnectionStatus,
  online: boolean,
): MatrixConnectionStatus {
  if (online || status === "offline" || status === "error") return status;
  return "offline";
}

export function connectionRepairReasonForDetail(
  detail?: string | null,
): ConnectionRepairReason | null {
  if (detail === "matrix_session_repair_required") return "matrix-session";
  if (detail === "matrix_project_authorization_repair_required") {
    return "project-authorization";
  }
  return null;
}

/**
 * Mobile chrome exposes one stable product signal instead of mirroring every
 * transport, authentication, recovery, and projection sub-phase. Detailed
 * reasons remain available inside connection settings and diagnostics.
 */
export function deriveMobileConnectionSignal(input: {
  trusted: boolean;
  status: MatrixConnectionStatus;
  gatewayAvailable: boolean;
}): MobileConnectionSignal {
  if (!input.trusted) return { state: "setup", label: "Connect" };
  if (input.status === "error") {
    return { state: "attention", label: "Attention" };
  }
  if (input.status === "offline") {
    return { state: "offline", label: "Offline" };
  }
  if (input.gatewayAvailable) return { state: "ready", label: "Online" };
  return { state: "progress", label: "Connecting" };
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
