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

test("derives activity from explicit Matrix status phases", () => {
  assert.equal(
    reduceAgentActivity(SENDING_AGENT_ACTIVITY, {
      version: 1,
      kind: "status",
      state: "running",
      activity_phase: "starting",
      provider: "codex",
    }),
    STARTING_AGENT_ACTIVITY,
  );

  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "status",
      state: "running",
      activity_phase: "starting",
    }),
    WORKING_AGENT_ACTIVITY,
  );

  assert.equal(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, {
      kind: "status",
      state: "running",
      activity_phase: "working",
    }),
    WORKING_AGENT_ACTIVITY,
  );
});

test("authenticated status drives every connected device", () => {
  assert.equal(
    reduceAgentActivity(null, {
      kind: "status",
      state: "running",
      activity_phase: "working",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "status",
      state: "stopping",
    }),
    STOPPING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(STOPPING_AGENT_ACTIVITY, {
      kind: "status",
      state: "idle",
    }),
    null,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "status",
      state: "failed",
    }),
    null,
  );
});

test("only authenticated status changes the interruptible execution state", () => {
  assert.equal(
    agentExecutionSignal({ kind: "status", state: "running" }),
    "running",
  );
  assert.equal(
    agentExecutionSignal({ kind: "status", state: "stopping" }),
    "stopping",
  );
  assert.equal(
    agentExecutionSignal({ kind: "message", operation_id: "message-1" }),
    null,
  );
  assert.equal(
    agentExecutionSignal({ kind: "decision_request", decision_id: "decision-1" }),
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

test("visible tools replace activity while permissions provide useful detail", () => {
  assert.equal(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, {
      kind: "message",
      operation_id: "tool-message-1",
      ui: { kind: "tool_group" },
    }),
    null,
  );
  assert.deepEqual(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "decision_request",
      decision_id: "permission-1",
      title: "Allow shell access?",
    }),
    {
      phase: "working",
      label: "Waiting for permission…",
      detail: "Allow shell access?",
    },
  );
});

test("a visible reply clears transient activity", () => {
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "message",
      operation_id: "message-1",
    }),
    null,
  );
});

test("unrelated and malformed events preserve the current activity", () => {
  assert.equal(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, { kind: "collaboration_command" }),
    STARTING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "unknown",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(STOPPING_AGENT_ACTIVITY, null),
    STOPPING_AGENT_ACTIVITY,
  );
});
