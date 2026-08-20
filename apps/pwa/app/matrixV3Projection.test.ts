import { describe, expect, it } from "vitest";
import type { CodeverV3Command, CodeverV3Event } from "@codever/protocol";
import { MatrixV3Projection } from "./matrixV3Projection";

describe("MatrixV3Projection", () => {
  it("converges per session despite out-of-order events and physical relation changes", () => {
    const projection = new MatrixV3Projection();
    projection.applyCommand(createCommand("a"), "$root-original", 1);
    projection.applyEvent(turnEvent("completed", 4, "idle"), "$physical-completed");
    projection.applyEvent(turnEvent("started", 3, "working"), "$physical-started");
    expect(projection.sessions.get("session-a")).toMatchObject({
      activity: "idle",
      stateVersion: 4,
      threadRootEventId: "$root-original",
    });
  });

  it("deduplicates command retries and retains history beyond an arbitrary sync window", () => {
    const projection = new MatrixV3Projection();
    const command = createCommand("a");
    expect(projection.applyCommand(command, "$root-1", 1)).toBe(true);
    expect(projection.applyCommand(command, "$root-rewritten", 2)).toBe(false);
    for (let index = 0; index < 500; index += 1) {
      projection.applyEvent(messageEvent(index), `$physical-${index}`);
    }
    expect(projection.sessionMessages("session-a")).toHaveLength(500);
  });

  it("tombstones only the targeted session without a global inventory revision", () => {
    const projection = new MatrixV3Projection();
    projection.applyCommand(createCommand("a"), "$root-a");
    projection.applyCommand(createCommand("b"), "$root-b");
    projection.applyEvent(lifecycleEvent("session-a", "deleted"), "$delete-a");
    expect(projection.visibleSessions().map(session => session.sessionId)).toEqual(["session-b"]);
  });

  it("restores the complete materialized view without depending on the current sync window", () => {
    const first = new MatrixV3Projection();
    first.applyCommand(createCommand("a"), "$root-a");
    first.applyEvent(messageEvent(1), "$message-a");
    const restored = new MatrixV3Projection();
    restored.restore(first.durableState());
    expect(restored.visibleSessions()).toEqual(first.visibleSessions());
    expect(restored.sessionMessages("session-a")).toEqual(first.sessionMessages("session-a"));
    expect(restored.applyEvent(messageEvent(1), "$duplicate")).toBe(false);
  });

  it("discovers a session from the latest event in a paged Matrix thread", () => {
    const projection = new MatrixV3Projection();
    projection.applyEvent(lifecycleEvent("session-c", "active"), "$latest-c", "$root-c");
    expect(projection.visibleSessions()).toEqual([
      expect.objectContaining({ sessionId: "session-c", threadRootEventId: "$root-c" }),
    ]);
  });
});

function createCommand(suffix: string): CodeverV3Command {
  return {
    kind: "codever.command",
    version: 3,
    commandId: `create-${suffix}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: `session-${suffix}`,
    deviceId: "device-1",
    certificateId: "certificate-1",
    createdAt: 1,
    operation: "session.create",
    payload: { operation: "session.create", title: suffix.toUpperCase() },
  };
}

function turnEvent(
  stage: "started" | "completed",
  stateVersion: number,
  activity: "working" | "idle",
): CodeverV3Event {
  return {
    kind: "codever.event",
    version: 3,
    eventId: `turn-${stage}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: "session-a",
    occurredAt: stateVersion,
    causationCommandId: "prompt-a",
    payload: stage === "started" ? {
      type: "turn.started",
      turnId: "prompt-a",
      projection: { title: "A", lifecycle: "active", activity, updatedAt: stateVersion, stateVersion },
    } : {
      type: "turn.completed",
      turnId: "prompt-a",
      outcome: "succeeded",
      projection: { title: "A", lifecycle: "active", activity, updatedAt: stateVersion, stateVersion },
    },
  };
}

function messageEvent(index: number): CodeverV3Event {
  return {
    kind: "codever.event",
    version: 3,
    eventId: `event-${index}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: "session-a",
    occurredAt: index + 2,
    payload: {
      type: "assistant.message",
      messageId: `message-${index}`,
      messageVersion: 1,
      body: `message ${index}`,
      format: "markdown",
      final: true,
      projection: { title: "A", lifecycle: "active", activity: "working", updatedAt: index + 2, stateVersion: 2 },
    },
  };
}

function lifecycleEvent(
  sessionId: string,
  state: "active" | "archived" | "deleted",
): CodeverV3Event {
  return {
    kind: "codever.event",
    version: 3,
    eventId: `lifecycle-${sessionId}-${state}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId,
    occurredAt: 3,
    causationCommandId: `delete-${sessionId}`,
    payload: {
      type: "session.lifecycle",
      state,
      projection: { title: sessionId, lifecycle: state, activity: "idle", updatedAt: 3, stateVersion: 2 },
    },
  };
}
