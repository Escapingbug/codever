import assert from "node:assert/strict";
import test from "node:test";
import {
  SENDING_AGENT_ACTIVITY,
  STARTING_AGENT_ACTIVITY,
  STOPPING_AGENT_ACTIVITY,
  WORKING_AGENT_ACTIVITY,
  agentExecutionSignal,
  agentActivityForPhase,
  reduceAgentActivity,
  shouldApplyAgentActivity,
} from "../app/agentActivity.ts";

test("exports stable, human-readable activity for local transitions", () => {
  assert.deepEqual(SENDING_AGENT_ACTIVITY, {
    phase: "sending",
    label: "Sending…",
  });
  assert.deepEqual(STARTING_AGENT_ACTIVITY, {
    phase: "starting",
    label: "Starting agent…",
  });
  assert.deepEqual(WORKING_AGENT_ACTIVITY, {
    phase: "working",
    label: "Agent is working…",
  });
  assert.deepEqual(STOPPING_AGENT_ACTIVITY, {
    phase: "stopping",
    label: "Stopping agent…",
  });
  assert.deepEqual(agentActivityForPhase("working", "  Reading files  "), {
    phase: "working",
    label: "Agent is working…",
    detail: "Reading files",
  });
});

test("derives starting activity from a Matrix io.codever querying status", () => {
  assert.equal(
    reduceAgentActivity(SENDING_AGENT_ACTIVITY, {
      version: 1,
      kind: "status",
      state: "querying",
      provider: "codex",
    }),
    STARTING_AGENT_ACTIVITY,
  );

  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "status",
      state: "querying",
    }),
    WORKING_AGENT_ACTIVITY,
  );
});

test("signed session lifecycle drives every connected device", () => {
  assert.equal(
    reduceAgentActivity(null, {
      type: "session.updated",
      status: "running",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "status",
      state: "canceling",
    }),
    STOPPING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      type: "session.updated",
      status: "stopping",
    }),
    STOPPING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(STOPPING_AGENT_ACTIVITY, {
      type: "session.updated",
      status: "idle",
    }),
    null,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      type: "session.updated",
      status: "failed",
    }),
    null,
  );
});

test("execution stays stoppable through partial text and tool completions", () => {
  assert.equal(
    agentExecutionSignal({ kind: "status", state: "running" }),
    "running",
  );
  assert.equal(
    agentExecutionSignal({ kind: "status", state: "canceling" }),
    "stopping",
  );
  assert.equal(
    agentExecutionSignal({
      type: "agent.text.completed",
      streamId: "stream-1",
      text: "partial answer",
    }),
    null,
  );
  assert.equal(
    agentExecutionSignal({
      type: "agent.tool.completed",
      toolCallId: "tool-1",
      status: "succeeded",
    }),
    null,
  );
  assert.equal(
    agentExecutionSignal({ kind: "status", state: "idle" }),
    "stopped",
  );
});

test("only live events for the selected session may drive activity", () => {
  assert.equal(
    shouldApplyAgentActivity("session-a", { sessionId: "session-a" }),
    true,
  );
  assert.equal(
    shouldApplyAgentActivity("session-a", { sessionId: "session-b" }),
    false,
  );
  assert.equal(
    shouldApplyAgentActivity("session-a", {
      sessionId: "session-a",
      historical: true,
    }),
    false,
  );
  assert.equal(
    shouldApplyAgentActivity(null, { sessionId: "session-a" }),
    false,
  );
});

test("tool and permission events provide useful working detail", () => {
  assert.deepEqual(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, {
      type: "agent.tool.started",
      toolCallId: "tool-1",
      name: "  Read  ",
    }),
    {
      phase: "working",
      label: "Using a tool…",
      detail: "Read",
    },
  );
  assert.deepEqual(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      type: "agent.permission.requested",
      requestId: "permission-1",
      title: "Allow shell access?",
    }),
    {
      phase: "working",
      label: "Waiting for permission…",
      detail: "Allow shell access?",
    },
  );
});

test("visible replies and terminal events clear transient activity", () => {
  const events = [
    { kind: "message", body: "Legacy projected reply" },
    { type: "agent.text.delta", streamId: "stream-1", text: "Hello" },
    { type: "agent.text.completed", streamId: "stream-1", text: "Hello" },
    {
      type: "agent.tool.completed",
      toolCallId: "tool-1",
      status: "succeeded",
    },
    { type: "agent.error", code: "agent_failed", message: "Failed" },
  ];

  for (const event of events) {
    assert.equal(
      reduceAgentActivity(WORKING_AGENT_ACTIVITY, event),
      null,
      event.type,
    );
  }
});

test("unrelated command completion does not end agent activity", () => {
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      type: "command.completed",
      commandId: "settings-command",
      outcome: "succeeded",
    }),
    WORKING_AGENT_ACTIVITY,
  );
});

test("unrelated and malformed events preserve the current activity", () => {
  assert.equal(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, { type: "command.accepted" }),
    STARTING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      type: "session.updated",
      status: "unknown",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(STOPPING_AGENT_ACTIVITY, null),
    STOPPING_AGENT_ACTIVITY,
  );
});
