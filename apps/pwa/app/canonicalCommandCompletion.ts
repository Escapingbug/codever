import type {
  CommandPayload,
  MatrixStateContent,
} from "@codever/protocol";

/**
 * Returns the canonical session id only when a Matrix-native state event is
 * sufficient proof that this exact desired-state command succeeded.
 */
export function canonicalSessionCommandResult(
  payload: CommandPayload,
  event: MatrixStateContent,
  projectedLifecycleState?: "active" | "archived" | "deleted" | null,
): string | null {
  if (event.kind !== "session_state") return null;
  const matchingState =
    (payload.operation === "session.create" && event.state === "active") ||
    (payload.operation === "session.settings" && event.state !== "deleted") ||
    (payload.operation === "session.archive" && event.state === "archived") ||
    (payload.operation === "session.restore" && event.state === "active") ||
    (payload.operation === "session.delete" && event.state === "deleted");
  if (!matchingState) return null;
  if (
    payload.operation !== "session.create" &&
    payload.sessionId !== event.session_id
  ) return null;
  if (
    projectedLifecycleState !== undefined &&
    projectedLifecycleState !== event.state
  ) return null;
  return event.session_id;
}
