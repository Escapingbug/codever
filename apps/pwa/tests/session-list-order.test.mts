import assert from "node:assert/strict";
import test from "node:test";
import type { GatewaySessionSummary } from "../app/gatewayState.ts";
import {
  compareProjectSessionsForAction,
  compareSessionsForAction,
  projectSessionSummaryLabel,
  sessionListSignal,
  sessionSignalLabel,
  summarizeProjectSessions,
} from "../app/sessionListOrder.ts";
import type { SessionReadState } from "../app/sessionIndicators.ts";

function session(
  id: string,
  status: GatewaySessionSummary["status"],
  updatedAt: number,
): GatewaySessionSummary {
  return {
    id,
    title: id,
    updatedAt,
    status,
    projectId: "project-a",
    projectName: "Project A",
    cwd: "/projects/a",
    provider: "codex",
    extensions: [],
  };
}

const readState: SessionReadState = {
  initialized: true,
  readUpdatedAt: {
    failed: 20,
    ready: 10,
    working: 30,
    idle: 100,
  },
};

test("derives quiet visual signals from lifecycle and read state", () => {
  assert.equal(sessionListSignal(session("failed", "failed", 20), readState), "failed");
  assert.equal(sessionListSignal(session("ready", "idle", 11), readState), "ready");
  assert.equal(sessionListSignal(session("working", "running", 30), readState), "working");
  assert.equal(sessionListSignal(session("idle", "idle", 40), readState), "idle");
  assert.equal(sessionSignalLabel("idle"), null);
});

test("sorts sessions and projects by action before recency", () => {
  const sessions = [
    session("idle", "idle", 100),
    session("working", "running", 30),
    session("ready", "idle", 11),
    session("failed", "failed", 20),
  ];
  sessions.sort((left, right) =>
    compareSessionsForAction(left, right, readState),
  );
  assert.deepEqual(sessions.map((item) => item.id), [
    "failed",
    "ready",
    "working",
    "idle",
  ]);

  assert.ok(
    compareProjectSessionsForAction(
      [session("idle", "idle", 100)],
      [session("ready", "idle", 11)],
      readState,
    ) > 0,
  );
});

test("summarizes project urgency into distinct compact signals", () => {
  const summary = summarizeProjectSessions(
    [
      session("failed", "failed", 20),
      session("ready", "idle", 11),
      session("working", "stopping", 30),
      session("idle", "idle", 40),
    ],
    readState,
  );
  assert.deepEqual(summary, { failed: 1, ready: 1, working: 1, total: 4 });
  assert.equal(
    projectSessionSummaryLabel("Project A", summary),
    "Project A, 1 conversation failed, 1 new result, 1 conversation is working, 4 conversations",
  );
});
