import type { CommandPayload } from "@codever/protocol";

/**
 * Device invitations have a terminal result that is still needed after the
 * command acknowledgement. Keep their signed outbox entry until the UI has
 * successfully turned that result into a usable invitation.
 */
export function retainsCommandUntilResultConsumed(
  payload: CommandPayload | unknown,
): boolean {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "operation" in payload &&
      payload.operation === "device.invite",
  );
}

export function isValidPendingCommandSequence(
  sequence: number,
  lastAcknowledged: number,
  payload: CommandPayload | unknown,
): boolean {
  return (
    sequence === lastAcknowledged + 1 ||
    (retainsCommandUntilResultConsumed(payload) &&
      sequence === lastAcknowledged)
  );
}
