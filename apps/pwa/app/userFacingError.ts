const GENERIC_ERROR_DETAIL = "The operation could not be completed.";
const COMMAND_RECOVERY_PENDING =
  /(?:command\s+[0-9a-f-]+\s+must be acknowledged, recovered, or discarded first|codever is restoring the previous queued action)/iu;

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
}

export function isCommandRecoveryPendingError(error: unknown): boolean {
  return COMMAND_RECOVERY_PENDING.test(errorMessage(error).replace(/\s+/gu, " ").trim());
}

/**
 * Keeps actionable product copy while preventing transport names, machine
 * codes, URLs, and JavaScript exception types from leaking into the UI.
 * Call sites may still retain the original error for diagnostics.
 */
export function formatUserFacingError(error: unknown): string {
  const raw = errorMessage(error);
  const message = raw.replace(/\s+/gu, " ").trim();
  if (!message) return GENERIC_ERROR_DETAIL;

  if (/\b(?:429|too many requests)\b/iu.test(message)) {
    return "Too many requests. Wait a moment and try again.";
  }
  if (COMMAND_RECOVERY_PENDING.test(message)) {
    return "Codever is restoring your previous action. Try again in a moment.";
  }
  if (/native bridge.*did not answer.*(?:in time|timed out)/iu.test(message)) {
    return "The connected device did not respond in time.";
  }
  if (
    /failed to fetch|network request failed|networkerror|load failed/iu.test(
      message,
    )
  ) {
    return "The network request did not complete.";
  }
  if (/\b(?:timed out|timeout)\b/iu.test(message)) {
    return "The operation took too long.";
  }
  if (/\b(?:aborterror|operation was aborted)\b/iu.test(message)) {
    return "The operation was interrupted. Please try again.";
  }
  if (
    /^(?:matrix|native|network)_[a-z0-9_]+$/u.test(message) ||
    (error instanceof Error &&
      /^(?:Type|Reference|Syntax|Range)Error$/u.test(error.name)) ||
    /^(?:type|reference|syntax|range)error\b/iu.test(message) ||
    /(?:https?|wss?):\/\//iu.test(message)
  ) {
    return GENERIC_ERROR_DETAIL;
  }

  return message.length <= 180 ? message : `${message.slice(0, 179)}…`;
}

export { GENERIC_ERROR_DETAIL };
