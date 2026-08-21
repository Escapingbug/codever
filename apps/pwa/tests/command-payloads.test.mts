import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, commandPayloadSchema } from "@codever/protocol";
import {
  createCancelCommandPayload,
  createPromptCommandPayload,
} from "../app/commandPayloads";

test("omits undefined attachments from plain-text prompt commands", () => {
  const payload = commandPayloadSchema.parse(
    createPromptCommandPayload({
      sessionId: "session-1",
      text: "hello",
      attachments: undefined,
    }),
  );

  assert.equal(Object.hasOwn(payload, "attachments"), false);
  assert.doesNotThrow(() => canonicalJson(payload));
});

test("preserves defined attachments in prompt commands", () => {
  const payload = commandPayloadSchema.parse(
    createPromptCommandPayload({
      sessionId: "session-1",
      text: "hello",
      attachments: [],
    }),
  );

  if (payload.operation !== "prompt") {
    assert.fail("Expected a prompt command payload.");
  }
  assert.deepEqual(payload.attachments, []);
  assert.doesNotThrow(() => canonicalJson(payload));
});

test("creates canonical session lifecycle commands", () => {
  for (const operation of [
    "session.archive",
    "session.restore",
    "session.delete",
  ] as const) {
    const payload = commandPayloadSchema.parse({
      operation,
      sessionId: "session-1",
    });
    assert.deepEqual(payload, { operation, sessionId: "session-1" });
    assert.doesNotThrow(() => canonicalJson(payload));
  }
});

test("preserves the scratch scope on session creation", () => {
  const payload = commandPayloadSchema.parse({
    operation: "session.create",
    scope: "scratch",
  });
  assert.equal(payload.operation, "session.create");
  assert.equal(payload.scope, "scratch");
});

test("targets the active CVP/3 turn when stopping a session", () => {
  const payload = commandPayloadSchema.parse(
    createCancelCommandPayload("session-1", "turn-1"),
  );

  assert.deepEqual(payload, {
    operation: "cancel",
    sessionId: "session-1",
    targetCommandId: "turn-1",
  });
});
