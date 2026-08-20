import assert from "node:assert/strict";
import test from "node:test";
const {
  findOptimisticMessageId,
  isAgentWorkMessage,
  mergeChatMessage,
  mergeChatMessages,
  withoutReconciledOptimisticCopies,
} = await import(new URL("../app/chatMessages.ts", import.meta.url).href);

test("identifies agent work messages without guessing from their text", () => {
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
    raw: { kind: "message" },
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

test("a late cache page cannot resurrect a reconciled optimistic copy", () => {
  const staleCached = {
    id: "user-local",
    kind: "user",
    text: "Run the checks",
    timestamp: 2_000,
    optimistic: true,
  };
  const canonical = {
    ...staleCached,
    eventId: "$canonical-user",
    optimistic: false,
  };
  const reconciled = new Set([staleCached.id]);

  assert.deepEqual(
    withoutReconciledOptimisticCopies([staleCached, canonical], reconciled),
    [canonical],
  );
});

test("a new revision epoch keeps a resumed prompt after old conversation history", () => {
  const current = [
    {
      id: "$old-user",
      eventId: "$old-user",
      kind: "user",
      timestamp: 1_000,
      revision: 80,
      raw: revisionMetadata("old-epoch", 1),
    },
    {
      id: "$old-agent",
      eventId: "$old-agent",
      kind: "agent",
      timestamp: 2_000,
    },
  ];
  const resumedPrompt = {
    id: "$resumed-user",
    eventId: "$resumed-user",
    kind: "user",
    timestamp: 100_000,
    revision: 1,
    raw: revisionMetadata("new-epoch", 2),
  };

  const messages = mergeChatMessage(current, resumedPrompt);

  assert.deepEqual(
    messages.map((message: { id: string }) => message.id),
    ["$old-user", "$old-agent", "$resumed-user"],
  );
});

test("user revisions remain authoritative inside one revision epoch", () => {
  const laterRevision = {
    id: "$revision-2",
    eventId: "$revision-2",
    kind: "user",
    timestamp: 1_000,
    revision: 2,
    raw: revisionMetadata("same-epoch", 4),
  };
  const earlierRevisionDeliveredLater = {
    id: "$revision-1",
    eventId: "$revision-1",
    kind: "user",
    timestamp: 100_000,
    revision: 1,
    raw: revisionMetadata("same-epoch", 4),
  };

  const messages = mergeChatMessage(
    [laterRevision],
    earlierRevisionDeliveredLater,
  );

  assert.deepEqual(
    messages.map((message: { id: string }) => message.id),
    ["$revision-1", "$revision-2"],
  );
});

test("legacy user messages without revision epoch metadata fall back to time", () => {
  const oldMessage = {
    id: "$legacy-old",
    eventId: "$legacy-old",
    kind: "user",
    timestamp: 1_000,
    revision: 80,
  };
  const newMessage = {
    id: "$legacy-new",
    eventId: "$legacy-new",
    kind: "user",
    timestamp: 100_000,
    revision: 1,
  };

  const messages = mergeChatMessage([oldMessage], newMessage);

  assert.deepEqual(
    messages.map((message: { id: string }) => message.id),
    ["$legacy-old", "$legacy-new"],
  );
});

function revisionMetadata(epoch: string, generation: number) {
  return {
    revision_epoch: epoch,
    revision_epoch_generation: generation,
  };
}

test("a Matrix edit preserves the logical message timeline position", () => {
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
    raw: { kind: "message" },
  };
  const completed = {
    id: "$completed",
    eventId: "$completed",
    kind: "agent",
    text: "First result",
    time: "10:01",
    timestamp: 2_000,
    replacesEventId: "$delta",
    raw: { kind: "message" },
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
    toolGroup: toolGroup("started", 1_100),
    raw: { kind: "message" },
  };
  const completed = {
    id: "$tool-completed",
    eventId: "$tool-completed",
    kind: "tool",
    text: "Tool succeeded",
    timestamp: 1_200,
    replacesEventId: "$tool-started",
    toolGroup: toolGroup("completed", 1_200),
    raw: { kind: "message" },
  };

  const terminal = mergeChatMessage([started], completed);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].id, started.id);
  assert.equal(terminal[0].text, completed.text);
  assert.equal(terminal[0].timestamp, started.timestamp);
  assert.equal(terminal[0].toolGroup?.tools[0]?.phase, "completed");

  const lateStarted = mergeChatMessage(terminal, {
    ...started,
    id: "$late-tool-started",
    eventId: "$late-tool-started",
    replacesEventId: "$tool-started",
  });
  assert.equal(lateStarted.length, 1);
  assert.equal(lateStarted[0].toolGroup?.tools[0]?.phase, "completed");
});

function toolGroup(
  phase: "started" | "updated" | "completed" | "failed",
  updatedAt: number,
) {
  return {
    kind: "tool_group" as const,
    version: 1 as const,
    groupId: "group-1",
    tools: [{
      id: "tool-1",
      name: "read_file",
      title: "Read file",
      category: "read" as const,
      phase,
      isError: phase === "failed",
      startedAt: 1_100,
      updatedAt,
    }],
  };
}

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

test("canonical Matrix echo reconciles an optimistic user message", () => {
  const optimistic = {
    id: "user-local",
    kind: "user",
    text: "Hello",
    timestamp: 2_000,
    commandId: "command-1",
    optimistic: true,
    raw: { source: "optimistic" },
  };
  const canonical = {
    id: "$canonical-user",
    eventId: "$canonical-user",
    kind: "user",
    text: "Hello",
    timestamp: 1_000,
    commandId: "command-1",
    raw: { source: "matrix" },
  };

  const messages = mergeChatMessage([optimistic], canonical);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, optimistic.id);
  assert.equal(messages[0].eventId, canonical.eventId);
  assert.equal(messages[0].timestamp, canonical.timestamp);
  assert.deepEqual(messages[0].raw, canonical.raw);
  assert.equal(messages[0].optimistic, false);
});

test("a transient lifecycle edit removes the transcript event it replaces", () => {
  const startup = {
    id: "$startup",
    eventId: "$startup",
    kind: "agent",
    text: "Starting",
    timestamp: 1_000,
    raw: { kind: "message" },
  };
  const statusEdit = {
    id: "$status-edit",
    eventId: "$status-edit",
    kind: "notice",
    text: "Agent started working...",
    timestamp: 1_100,
    replacesEventId: "$startup",
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

test("a live event upgrades an identical historical event regardless of arrival order", () => {
  const historical = {
    id: "$permission",
    eventId: "$permission",
    operationId: "permission-operation",
    requestId: "permission-request",
    kind: "permission",
    text: "Allow this action?",
    timestamp: 1_000,
    historical: true,
  };
  const live = {
    ...historical,
    text: "Allow this action now?",
    historical: undefined,
  };

  const historyThenLive = mergeChatMessages([], [historical, live]);
  const liveThenHistory = mergeChatMessages([], [live, historical]);

  assert.equal(historyThenLive.length, 1);
  assert.equal(historyThenLive[0].historical, false);
  assert.equal(historyThenLive[0].text, live.text);
  assert.equal(liveThenHistory.length, 1);
  assert.equal(liveThenHistory[0].historical, false);
  assert.equal(liveThenHistory[0].text, live.text);
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
