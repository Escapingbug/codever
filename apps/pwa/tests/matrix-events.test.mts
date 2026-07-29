import assert from "node:assert/strict";
import test from "node:test";
import { parseCodeverEvent } from "../app/matrix";

function signedAgentEvent(payload: Record<string, unknown>) {
  return {
    body: "Encrypted Codever message",
    "io.codever": {
      version: 1,
      kind: "signed_event",
      signed_event: {
        event: { payload },
      },
    },
  };
}

test("preserves a stable tool call ID and lifecycle status across updates", () => {
  const started = parseCodeverEvent(
    "$tool-started",
    "@gateway:example.com",
    1_700_000_000_000,
    true,
    signedAgentEvent({
      type: "agent.tool.started",
      toolCallId: "tool-call-1",
      name: "Read file",
      input: { path: "README.md" },
    }),
  );
  const completed = parseCodeverEvent(
    "$tool-completed",
    "@gateway:example.com",
    1_700_000_000_100,
    true,
    signedAgentEvent({
      type: "agent.tool.completed",
      toolCallId: "tool-call-1",
      status: "succeeded",
      output: { lines: 12 },
    }),
  );

  assert.ok(started);
  assert.deepEqual(
    {
      kind: started.kind,
      text: started.text,
      toolCallId: started.toolCallId,
      toolStatus: started.toolStatus,
    },
    {
      kind: "tool",
      text: "Read file",
      toolCallId: "tool-call-1",
      toolStatus: "running",
    },
  );
  assert.ok(completed);
  assert.deepEqual(
    {
      kind: completed.kind,
      toolCallId: completed.toolCallId,
      toolStatus: completed.toolStatus,
    },
    {
      kind: "tool",
      toolCallId: "tool-call-1",
      toolStatus: "succeeded",
    },
  );
  assert.equal("name" in completed.raw, false);
  assert.equal(completed.toolCallId, started.toolCallId);
});

test("exposes a failed terminal tool status", () => {
  const failed = parseCodeverEvent(
    "$tool-failed",
    "@gateway:example.com",
    1_700_000_000_200,
    true,
    signedAgentEvent({
      type: "agent.tool.completed",
      toolCallId: "tool-call-2",
      status: "failed",
    }),
  );

  assert.ok(failed);
  assert.deepEqual(
    {
      kind: failed.kind,
      toolCallId: failed.toolCallId,
      toolStatus: failed.toolStatus,
    },
    {
      kind: "tool",
      toolCallId: "tool-call-2",
      toolStatus: "failed",
    },
  );
});
