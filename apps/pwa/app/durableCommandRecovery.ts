import type { CommandPayload } from "@codever/protocol";

/**
 * Some commands have a terminal result that is still needed after the command
 * acknowledgement. Keep their signed outbox entry until the UI has consumed
 * the result, so reconnecting can replay the same command ID without repeating
 * its side effect.
 */
export function retainsCommandUntilResultConsumed(
  payload: CommandPayload | unknown,
): boolean {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "operation" in payload &&
      (payload.operation === "device.invite" ||
        payload.operation === "session.create"),
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
