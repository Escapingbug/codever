import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  decodeHistoryBatchPayload,
  parseCodeverEvent,
  parseHistoryReplayEvent,
} from "../app/matrix";

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

test("parses signed structured attachments without relying on fallback text", () => {
  const attachment = {
    id: "artifact-1",
    name: "diagram.png",
    mimeType: "image/png",
    size: 12,
    sha256: "A".repeat(43),
    media: {
      url: "mxc://example.com/media-1",
      key: "B".repeat(43),
      iv: "C".repeat(16),
      sha256: "D".repeat(43),
      size: 28,
    },
  };
  const message = parseCodeverEvent(
    "$artifact",
    "@gateway:example.com",
    1_700_000_000_300,
    true,
    {
      msgtype: "m.text",
      body: "Generated image",
      "io.codever": {
        version: 1,
        kind: "message",
        operation_id: "operation-artifact",
        format: "plain",
        attachments: [attachment],
      },
    },
  );

  assert.ok(message);
  assert.deepEqual(message.attachments, [attachment]);
  assert.equal(message.operationId, "operation-artifact");
});

test("preserves operation and replacement identities for status edits", () => {
  const message = parseCodeverEvent(
    "$status-edit",
    "@gateway:example.com",
    1_700_000_000_350,
    true,
    {
      msgtype: "m.notice",
      body: "* Agent is ready",
      "io.codever": {
        version: 1,
        kind: "status",
      },
      "m.new_content": {
        msgtype: "m.notice",
        body: "Agent is ready",
        "io.codever": {
          version: 1,
          kind: "status",
          operation_id: "operation-status-edit",
        },
      },
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: "$status-original",
      },
    },
  );

  assert.ok(message);
  assert.equal(message.operationId, "operation-status-edit");
  assert.equal(message.replacesEventId, "$status-original");
});

test("marks replayed decisions as display-only historical messages", () => {
  const replay = parseHistoryReplayEvent(
    "$historical-decision",
    "@gateway:example.com",
    1_700_000_000_400,
    {
      msgtype: "m.notice",
      body: "Allow this command?",
      "io.codever": {
        version: 1,
        kind: "decision_request",
        session_id: "session-1",
        decision_id: "decision-1",
        title: "Allow this command?",
        history_replay: {
          request_id: "history-request-1",
          display_only: true,
          timestamp: 1_600_000_000_000,
        },
      },
    },
  );

  assert.ok(replay);
  assert.equal(replay.requestId, "history-request-1");
  assert.deepEqual(
    {
      kind: replay.message.kind,
      requestId: replay.message.requestId,
      sessionId: replay.message.sessionId,
      historical: replay.message.historical,
      timestamp: replay.message.timestamp,
    },
    {
      kind: "permission",
      requestId: "decision-1",
      sessionId: "session-1",
      historical: true,
      timestamp: 1_600_000_000_000,
    },
  );
});

test("restores an authenticated failed command result as transcript history", () => {
  const replay = parseHistoryReplayEvent(
    "$historical-failure",
    "@gateway:example.com",
    1_700_000_000_500,
    {
      msgtype: "m.notice",
      body: "Encrypted Codever command status",
      "io.codever": {
        version: 1,
        kind: "command_result",
        command_id: "command-1",
        session_id: "session-1",
        sequence: 1,
        revision: 2,
        revision_epoch: "epoch-1",
        outcome: "failed",
        error: "Provider disconnected",
        history_replay: {
          request_id: "history-request-2",
          display_only: true,
          timestamp: 1_600_000_000_100,
        },
      },
    },
  );

  assert.ok(replay);
  assert.deepEqual(
    {
      kind: replay.message.kind,
      text: replay.message.text,
      commandId: replay.message.commandId,
      sessionId: replay.message.sessionId,
      historical: replay.message.historical,
    },
    {
      kind: "error",
      text: "Provider disconnected",
      commandId: "command-1",
      sessionId: "session-1",
      historical: true,
    },
  );
});

test("validates a downloaded history batch against its signed metadata", async () => {
  const items = [
    {
      eventId: "E".repeat(43),
      timestamp: 1_700_000_000_600,
      content: {
        msgtype: "m.text",
        body: "Recovered response",
        "io.codever": {
          version: 1,
          kind: "message",
          session_id: "session-1",
          format: "markdown",
        },
      },
    },
  ];
  const plaintext = new TextEncoder().encode(JSON.stringify(items));
  const batch = {
    encoding: "json" as const,
    itemCount: 1,
    plaintextSize: plaintext.byteLength,
    plaintextSha256: createHash("sha256").update(plaintext).digest("base64url"),
    media: {
      url: "mxc://example.org/history-1",
      key: "K".repeat(43),
      iv: "I".repeat(16),
      sha256: "S".repeat(43),
      size: plaintext.byteLength + 16,
    },
  };

  assert.deepEqual(await decodeHistoryBatchPayload(plaintext, batch), items);
  await assert.rejects(
    decodeHistoryBatchPayload(plaintext, {
      ...batch,
      plaintextSha256: "X".repeat(43),
    }),
    /signed metadata/,
  );
  await assert.rejects(
    decodeHistoryBatchPayload(plaintext, { ...batch, itemCount: 2 }),
    /item count/,
  );
});

test("uses authenticated logical event identities instead of Matrix transport IDs", () => {
  const logicalEventId = "L".repeat(43);
  const logicalTargetId = "T".repeat(43);
  const message = parseCodeverEvent(
    "$physical-event",
    "@gateway:example.org",
    1_700_000_000_700,
    true,
    {
      msgtype: "m.text",
      body: "updated once for every device",
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: "$physical-target",
      },
      "io.codever": {
        version: 1,
        kind: "message",
        logical_event_id: logicalEventId,
        replaces_logical_event_id: logicalTargetId,
      },
    },
  );

  assert.ok(message);
  assert.equal(message.eventId, logicalEventId);
  assert.equal(message.replacesEventId, logicalTargetId);
});
