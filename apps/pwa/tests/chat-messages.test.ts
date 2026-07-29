import assert from "node:assert/strict";
import test from "node:test";
const {
  findOptimisticMessageId,
  mergeChatMessage,
  mergeChatMessages,
} = await import(new URL("../app/chatMessages.ts", import.meta.url).href);

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
