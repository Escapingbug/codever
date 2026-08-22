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
    deliveryState: "sending",
    raw: { source: "optimistic" },
  };
  const canonical = {
    id: "$canonical-user",
    eventId: "$canonical-user",
    kind: "user",
    text: "Hello",
    timestamp: 1_000,
    commandId: "command-1",
    deliveryState: "sent",
    raw: { source: "matrix" },
  };

  const messages = mergeChatMessage([optimistic], canonical);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, optimistic.id);
  assert.equal(messages[0].eventId, canonical.eventId);
  assert.equal(messages[0].timestamp, canonical.timestamp);
  assert.deepEqual(messages[0].raw, canonical.raw);
  assert.equal(messages[0].optimistic, false);
  assert.equal(messages[0].deliveryState, "sent");
});

test("a CVP/3 Agent response is not merged into its causal user command", () => {
  const messages = mergeChatMessages([], [
    {
      id: "$user",
      eventId: "$user",
      kind: "user",
      text: "Implement the change",
      timestamp: 1_000,
      commandId: "command-1",
    },
    {
      id: "$agent",
      eventId: "$agent",
      kind: "agent",
      text: "Implemented the change",
      timestamp: 1_100,
      commandId: "command-1",
    },
  ]);

  assert.deepEqual(
    messages.map((message) => [message.kind, message.text]),
    [
      ["user", "Implement the change"],
      ["agent", "Implemented the change"],
    ],
  );
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

test("migrates a legacy Matrix-event-keyed bubble to its stable CVP logical identity", () => {
  const legacyCached = {
    id: "$physical-v1",
    eventId: "$physical-v1",
    kind: "agent",
    text: "Working",
    timestamp: 1_000,
    historical: true,
  };
  const canonical = {
    id: "assistant:message-1:0",
    eventId: "assistant:message-1:0",
    replacesEventId: "$physical-v1",
    kind: "agent",
    text: "Done",
    timestamp: 1_100,
  };

  const migrated = mergeChatMessage([legacyCached], canonical);

  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].eventId, canonical.eventId);
  assert.equal(migrated[0].text, "Done");
  assert.ok(migrated[0].eventAliases?.includes("$physical-v1"));

  const recoveredAgain = mergeChatMessage(migrated, {
    ...canonical,
    id: "$legacy-ui-id-that-survived-an-upgrade",
    replacesEventId: "$physical-v2",
    historical: true,
  });

  assert.equal(recoveredAgain.length, 1);
  assert.equal(recoveredAgain[0].eventId, canonical.eventId);
});

test("reassembles CVP/3 transport parts into one agent bubble", () => {
  const messages = mergeChatMessages([], [
    cvp3Part({ index: 0, count: 2, text: "A".repeat(8_192) }),
    cvp3Part({ index: 1, count: 2, text: "收尾" }),
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "assistant:message-long:multipart");
  assert.equal(messages[0].kind, "agent");
  assert.equal(messages[0].text, `${"A".repeat(8_192)}收尾`);
  assert.deepEqual(messages[0].multipart?.parts, {
    0: "A".repeat(8_192),
    1: "收尾",
  });
});

test("keeps a multipart tool as one tool card when a tail arrived as agent text", () => {
  const tail = cvp3Part({ index: 1, count: 2, text: "完成" });
  const first = {
    ...cvp3Part({ index: 0, count: 2, text: "Run command\n" }),
    kind: "tool",
    toolGroup: toolGroup("completed", 1_100),
  };

  const messages = mergeChatMessages([], [tail, first]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "tool");
  assert.equal(messages[0].text, "Run command\n完成");
  assert.equal(messages[0].toolGroup?.tools[0]?.phase, "completed");
});

test("a newer multipart version replaces all parts without leaving stale text", () => {
  const versionOne = mergeChatMessages([], [
    cvp3Part({ index: 0, count: 2, text: "old ", version: 1 }),
    cvp3Part({ index: 1, count: 2, text: "tail", version: 1 }),
  ]);
  const versionTwo = mergeChatMessages(versionOne, [
    cvp3Part({ index: 0, count: 2, text: "new ", version: 2 }),
    cvp3Part({ index: 1, count: 2, text: "result", version: 2 }),
  ]);

  assert.equal(versionTwo.length, 1);
  assert.equal(versionTwo[0].text, "new result");
  assert.deepEqual(versionTwo[0].multipart?.versions, { 0: 2, 1: 2 });
});

test("reassembles a growing streamed message with independent part versions", () => {
  const short = mergeChatMessages([], [
    cvp3Part({ index: 0, count: 1, text: "short", version: 1 }),
  ]);
  const growing = mergeChatMessages(short, [
    cvp3Part({ index: 0, count: 2, text: "A".repeat(8_192), version: 2 }),
    cvp3Part({ index: 1, count: 2, text: "Markdown tail", version: 1 }),
  ]);

  assert.equal(growing.length, 1);
  assert.equal(growing[0].text, `${"A".repeat(8_192)}Markdown tail`);
  assert.deepEqual(growing[0].multipart?.versions, { 0: 2, 1: 1 });
});

test("a streamed agent message replaces partial markdown with its cumulative version", () => {
  const partial = cvp3Part({
    index: 0,
    count: 1,
    text: "```ts\nconst value",
    version: 1,
  });
  const complete = cvp3Part({
    index: 0,
    count: 1,
    text: "```ts\nconst value = 1;\n```",
    version: 2,
  });

  const messages = mergeChatMessages([partial], [complete]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "```ts\nconst value = 1;\n```");
  assert.equal(messages[0].raw?.messageVersion, 2);
});

function cvp3Part(input: {
  index: number;
  count: number;
  text: string;
  version?: number;
}) {
  return {
    id: `assistant:message-long:${input.index}`,
    eventId: `assistant:message-long:${input.index}`,
    kind: "agent",
    text: input.text,
    timestamp: 1_000 + input.index,
    sessionId: "session-1",
    raw: {
      type: "assistant.message",
      messageId: "message-long",
      messageVersion: input.version ?? 1,
      partIndex: input.index,
      partCount: input.count,
    },
  };
}
