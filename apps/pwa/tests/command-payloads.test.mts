import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, commandPayloadSchema } from "@codever/protocol";
import { createPromptCommandPayload } from "../app/commandPayloads";

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
