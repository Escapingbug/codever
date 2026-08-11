import type { CommandPayload, MatrixNativeContent } from "@codever/protocol";

type CanonicalSessionEvent = Extract<
  MatrixNativeContent,
  { kind: "session_root" | "session_update" | "session_lifecycle" }
>;

/**
 * Returns the canonical session id only when a Matrix-native state event is
 * sufficient proof that this exact desired-state command succeeded.
 */
export function canonicalSessionCommandResult(
  payload: CommandPayload,
  event: MatrixNativeContent,
): string | null {
  if (!isCanonicalSessionEvent(event)) return null;
  const matchingKind =
    (payload.operation === "session.create" && event.kind === "session_root") ||
    (payload.operation === "session.settings" && event.kind === "session_update") ||
    (payload.operation === "session.archive" &&
      event.kind === "session_lifecycle" &&
      event.state === "archived") ||
    (payload.operation === "session.restore" &&
      event.kind === "session_lifecycle" &&
      event.state === "idle") ||
    (payload.operation === "session.delete" &&
      event.kind === "session_lifecycle" &&
      event.state === "deleted");
  if (!matchingKind) return null;
  if (
    payload.operation !== "session.create" &&
    payload.sessionId !== event.session_id
  ) {
    return null;
  }
  return event.session_id;
}

function isCanonicalSessionEvent(
  event: MatrixNativeContent,
): event is CanonicalSessionEvent {
  return (
    event.kind === "session_root" ||
    event.kind === "session_update" ||
    event.kind === "session_lifecycle"
  );
}
