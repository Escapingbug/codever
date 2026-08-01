import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidPendingCommandSequence,
  retainsCommandUntilResultConsumed,
} from "../app/durableCommandRecovery.ts";

test("device invitations remain recoverable after acknowledgement", () => {
  const payload = {
    operation: "device.invite" as const,
    lifetimeMs: 300_000,
  };

  assert.equal(retainsCommandUntilResultConsumed(payload), true);
  assert.equal(isValidPendingCommandSequence(4, 3, payload), true);
  assert.equal(isValidPendingCommandSequence(4, 4, payload), true);
  assert.equal(isValidPendingCommandSequence(4, 5, payload), false);
});

test("ordinary commands leave the outbox as soon as they are acknowledged", () => {
  const payload = {
    operation: "prompt" as const,
    sessionId: "session-1",
    text: "hello",
  };

  assert.equal(retainsCommandUntilResultConsumed(payload), false);
  assert.equal(isValidPendingCommandSequence(4, 3, payload), true);
  assert.equal(isValidPendingCommandSequence(4, 4, payload), false);
});
