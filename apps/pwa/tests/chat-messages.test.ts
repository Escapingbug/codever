import assert from "node:assert/strict";
import test from "node:test";
const {
  findOptimisticMessageId,
  isAgentWorkMessage,
  legacyCommandText,
  mergeChatMessage,
  mergeChatMessages,
} = await import(new URL("../app/chatMessages.ts", import.meta.url).href);

test("recognizes legacy shell messages for the modern command presentation", () => {
  assert.equal(
    legacyCommandText({ kind: "agent", text: "💻 $ pnpm test\n--runInBand" }),
    "pnpm test\n--runInBand",
  );
  assert.equal(legacyCommandText({ kind: "agent", text: "Final answer" }), undefined);
  assert.equal(legacyCommandText({ kind: "user", text: "💻 $ pnpm test" }), undefined);
  assert.equal(isAgentWorkMessage({ kind: "agent" }), true);
  assert.equal(isAgentWorkMessage({ kind: "tool" }), true);
  assert.equal(isAgentWorkMessage({ kind: "user" }), false);
});

test("authoritative user echo repairs clock-skewed optimistic ordering", () => {
  const optimistic = {
    id: "user-local",
    kind: "user",
    text: "Run the checks",
    timestamp: 2_000,
    commandId: "command-1",
    sessionId: "session-1",
    optimistic: true,
  };
  const firstAgentDelta = {
    id: "$agent-delta",
    eventId: "$agent-delta",
    kind: "agent",
    text: "Checking",
    timestamp: 1_900,
    streamId: "stream-1",
    raw: { type: "agent.text.delta" },
  };
  const initiallyMisordered = mergeChatMessage(
    [optimistic],
    firstAgentDelta,
  );
  assert.deepEqual(
    initiallyMisordered.map((message: { kind: string }) => message.kind),
    ["agent", "user"],
  );

  const canonicalUser = {
    id: "$canonical-user",
    eventId: "$canonical-user",
    kind: "user",
    text: "Run the checks",
    timestamp: 1_800,
    commandId: "command-1",
    revision: 1,
    sessionId: "session-1",
  };
  const repaired = mergeChatMessage(initiallyMisordered, canonicalUser, {
    reconcileMessageId: optimistic.id,
  });

  assert.deepEqual(
    repaired.map((message: { kind: string }) => message.kind),
    ["user", "agent"],
  );
  assert.equal(repaired[0].id, optimistic.id);
  assert.equal(repaired[0].eventId, canonicalUser.eventId);
  assert.equal(repaired[0].timestamp, canonicalUser.timestamp);
  assert.equal(repaired[0].optimistic, false);
});

test("stream completion preserves the logical message timeline position", () => {
  const user = {
    id: "$user",
    eventId: "$user",
    kind: "user",
    timestamp: 1_000,
  };
  const delta = {
    id: "$delta",
    eventId: "$delta",
    kind: "agent",
    text: "First",
    time: "10:00",
    timestamp: 1_100,
    streamId: "stream-1",
    raw: { type: "agent.text.delta" },
  };
  const completed = {
    id: "$completed",
    eventId: "$completed",
    kind: "agent",
    text: "First result",
    time: "10:01",
    timestamp: 2_000,
    streamId: "stream-1",
    raw: { type: "agent.text.completed" },
  };

  const merged = mergeChatMessage(
    mergeChatMessage([user], delta),
    completed,
  );

  assert.deepEqual(
    merged.map((message: { kind: string }) => message.kind),
    ["user", "agent"],
  );
  assert.equal(merged[1].timestamp, delta.timestamp);
  assert.equal(merged[1].time, delta.time);
  assert.equal(merged[1].text, completed.text);
});

test("tool completion updates one card and cannot regress to running", () => {
  const started = {
    id: "$tool-started",
    eventId: "$tool-started",
    kind: "tool",
    text: "Read file",
    timestamp: 1_100,
    toolCallId: "tool-1",
    toolStatus: "running",
    raw: { type: "agent.tool.started", name: "Read file" },
  };
  const completed = {
    id: "$tool-completed",
    eventId: "$tool-completed",
    kind: "tool",
    text: "Tool succeeded",
    timestamp: 1_200,
    toolCallId: "tool-1",
    toolStatus: "succeeded",
    raw: { type: "agent.tool.completed", status: "succeeded" },
  };

  const terminal = mergeChatMessage([started], completed);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].id, started.id);
  assert.equal(terminal[0].text, started.text);
  assert.equal(terminal[0].timestamp, started.timestamp);
  assert.equal(terminal[0].toolStatus, "succeeded");

  const lateStarted = mergeChatMessage(terminal, {
    ...started,
    id: "$late-tool-started",
  });
  assert.equal(lateStarted.length, 1);
  assert.equal(lateStarted[0].toolStatus, "succeeded");
});

test("canonical history wins over a persisted optimistic duplicate", () => {
  const messages = mergeChatMessages([], [
    {
      id: "user-local",
      kind: "user",
      text: "Hello",
      timestamp: 2_000,
      commandId: "command-1",
      optimistic: true,
    },
    {
      id: "$canonical-user",
      eventId: "$canonical-user",
      kind: "user",
      text: "Hello",
      timestamp: 1_000,
      commandId: "command-1",
    },
    {
      id: "$agent",
      eventId: "$agent",
      kind: "agent",
      text: "Hi",
      timestamp: 1_100,
    },
  ]);

  assert.deepEqual(
    messages.map((message: { kind: string }) => message.kind),
    ["user", "agent"],
  );
  assert.equal(messages[0].eventId, "$canonical-user");
});

test("legacy startup placeholders never enter the visible transcript", () => {
  const messages = mergeChatMessages([], [
    {
      id: "$legacy-startup",
      eventId: "$legacy-startup",
      kind: "agent",
      text: "⏳ Agent is starting up, please wait...",
      format: "html",
      attachments: [],
      timestamp: 1_000,
      raw: { kind: "message" },
    },
  ]);

  assert.deepEqual(messages, []);
});

test("a transient legacy status edit removes its startup placeholder", () => {
  const startup = {
    id: "$legacy-startup",
    eventId: "$legacy-startup",
    kind: "agent",
    text: "Legacy startup placeholder",
    timestamp: 1_000,
    raw: { kind: "message" },
  };
  const statusEdit = {
    id: "$status-edit",
    eventId: "$status-edit",
    kind: "notice",
    text: "Agent started working...",
    timestamp: 1_100,
    replacesEventId: "$legacy-startup",
    raw: { kind: "status", state: "working" },
  };

  assert.deepEqual(mergeChatMessage([startup], statusEdit), []);
});

test("live and history copies of one logical Matrix message stay in one bubble", () => {
  const liveOriginal = {
    id: "$physical-original",
    eventId: "$physical-original",
    operationId: "operation-original",
    kind: "tool",
    text: "Editing files",
    timestamp: 1_000,
  };
  const liveEdit = {
    id: "$physical-edit",
    eventId: "$physical-edit",
    operationId: "operation-edit",
    replacesEventId: "$physical-original",
    kind: "tool",
    text: "Editing files",
    timestamp: 1_100,
  };
  const historyOriginal = {
    ...liveOriginal,
    id: "history-original",
    eventId: "history-original",
    historical: true,
  };
  const historyEdit = {
    ...liveEdit,
    id: "history-edit",
    eventId: "history-edit",
    replacesEventId: "history-original",
    historical: true,
  };

  const merged = mergeChatMessages([], [
    liveOriginal,
    liveEdit,
    historyOriginal,
    historyEdit,
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, liveOriginal.id);
  assert.equal(merged[0].eventId, liveEdit.eventId);
  assert.deepEqual(
    new Set(merged[0].mergedOperationIds),
    new Set(["operation-original", "operation-edit"]),
  );
  assert.ok(merged[0].eventAliases?.includes("history-original"));
});

test("a history edit can target the alias learned from its live original", () => {
  const liveOriginal = {
    id: "$physical-original",
    eventId: "$physical-original",
    operationId: "operation-original",
    kind: "agent",
    text: "Before",
    timestamp: 1_000,
  };
  const historyOriginal = {
    ...liveOriginal,
    id: "history-original",
    eventId: "history-original",
    historical: true,
  };
  const historyOnlyEdit = {
    id: "history-edit",
    eventId: "history-edit",
    operationId: "operation-edit",
    replacesEventId: "history-original",
    kind: "agent",
    text: "After",
    timestamp: 1_100,
    historical: true,
  };

  const merged = mergeChatMessages([], [
    liveOriginal,
    historyOriginal,
    historyOnlyEdit,
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "After");
});

test("identical text from different operations remains distinct", () => {
  const merged = mergeChatMessages([], [
    {
      id: "$first",
      eventId: "$first",
      operationId: "operation-first",
      kind: "agent",
      text: "Same text",
      timestamp: 1_000,
    },
    {
      id: "$second",
      eventId: "$second",
      operationId: "operation-second",
      kind: "agent",
      text: "Same text",
      timestamp: 1_100,
    },
  ]);

  assert.equal(merged.length, 2);
});

test("optimistic echo matching prefers command id and falls back to session text", () => {
  const references = [
    {
      id: "first",
      text: "Repeat",
      sessionId: "session-1",
      commandId: "command-1",
    },
    {
      id: "second",
      text: "Repeat",
      sessionId: "session-1",
    },
  ];

  assert.equal(
    findOptimisticMessageId(references, {
      text: "Repeat",
      sessionId: "session-1",
      commandId: "command-1",
    }),
    "first",
  );
  assert.equal(
    findOptimisticMessageId(references, {
      text: "Repeat",
      sessionId: "session-1",
    }),
    "second",
  );
});
