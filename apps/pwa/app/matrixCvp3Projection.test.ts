import { describe, expect, it } from "vitest";
import type { Cvp3Command, Cvp3Event } from "@codever/protocol";
import { MatrixCvp3Projection } from "./matrixCvp3Projection";

describe("MatrixCvp3Projection", () => {
  it("converges per session despite out-of-order events and physical relation changes", () => {
    const projection = new MatrixCvp3Projection();
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
    const projection = new MatrixCvp3Projection();
    const command = createCommand("a");
    expect(projection.applyCommand(command, "$root-1", 1)).toBe(true);
    expect(projection.applyCommand(command, "$root-rewritten", 2)).toBe(false);
    for (let index = 0; index < 500; index += 1) {
      projection.applyEvent(messageEvent(index), `$physical-${index}`);
    }
    expect(projection.sessionMessages("session-a")).toHaveLength(500);
  });

  it("tombstones only the targeted session without a global inventory revision", () => {
    const projection = new MatrixCvp3Projection();
    projection.applyCommand(createCommand("a"), "$root-a");
    projection.applyCommand(createCommand("b"), "$root-b");
    projection.applyEvent(lifecycleEvent("session-a", "deleted"), "$delete-a");
    expect(projection.visibleSessions().map(session => session.sessionId)).toEqual(["session-b"]);
  });

  it("restores the complete materialized view without depending on the current sync window", () => {
    const first = new MatrixCvp3Projection();
    first.applyCommand(createCommand("a"), "$root-a");
    first.applyEvent(messageEvent(1), "$message-a");
    const restored = new MatrixCvp3Projection();
    restored.restore(first.durableState());
    expect(restored.visibleSessions()).toEqual(first.visibleSessions());
    expect(restored.sessionMessages("session-a")).toEqual(first.sessionMessages("session-a"));
    expect(restored.applyEvent(messageEvent(1), "$duplicate")).toBe(false);
  });

  it("discovers a session from the latest event in a paged Matrix thread", () => {
    const projection = new MatrixCvp3Projection();
    projection.applyEvent(lifecycleEvent("session-c", "active"), "$latest-c", "$root-c");
    expect(projection.visibleSessions()).toEqual([
      expect.objectContaining({ sessionId: "session-c", threadRootEventId: "$root-c" }),
    ]);
  });

  it("persists the newest authenticated workspace capability catalog", () => {
    const projection = new MatrixCvp3Projection();
    projection.applyEvent(workspaceSnapshot(2, "gpt-5.6-sol"), "$workspace-2");
    projection.applyEvent(workspaceSnapshot(1, "stale-model"), "$workspace-1");

    expect(projection.workspace).toEqual(expect.objectContaining({
      snapshotVersion: 2,
      capabilities: expect.objectContaining({
        models: [expect.objectContaining({ id: "gpt-5.6-sol" })],
      }),
    }));

    const restored = new MatrixCvp3Projection();
    restored.restore(projection.durableState());
    expect(restored.workspace).toEqual(projection.workspace);
  });

  it("projects extension defaults and resolves an interaction on every device", () => {
    const projection = new MatrixCvp3Projection();
    projection.applyEvent(projectSnapshot(), "$project");
    projection.applyCommand(createCommand("a"), "$root-a");
    projection.applyEvent(extensionInteraction("requested"), "$request");
    projection.applyEvent(extensionInteraction("resolved"), "$resolved");

    expect(projection.project).toMatchObject({
      defaultExtensions: [{ id: "prefix-transform" }],
      installedExtensions: [{ id: "prefix-transform" }],
    });
    expect(projection.messages.get("decision:extension-request-1")).toMatchObject({
      resolvedActionId: "continue",
      physicalEventId: "$resolved",
      version: 2,
    });
  });
});

function workspaceSnapshot(snapshotVersion: number, model: string): Cvp3Event {
  return {
    kind: "codever.event",
    version: 3,
    eventId: `workspace-${snapshotVersion}`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    occurredAt: snapshotVersion,
    payload: {
      type: "workspace.snapshot",
      protocolMin: 3,
      protocolMax: 3,
      gatewayKeyId: "gateway-key-1",
      capabilities: {
        models: [{
          id: model,
          name: model,
          default_reasoning_level: "high",
          supported_reasoning_levels: [{ effort: "high" }],
        }],
        permission_modes: [{ id: "default", name: "Default" }],
        can_create_session: true,
        can_select_session: false,
        can_archive_session: true,
        can_delete_session: true,
        session_extensions: [],
      },
      snapshotVersion,
    },
  };
}

function projectSnapshot(): Cvp3Event {
  return {
    kind: "codever.event",
    version: 3,
    eventId: "project-snapshot-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    occurredAt: 1,
    payload: {
      type: "project.snapshot",
      name: "Project",
      cwd: "/repo",
      provider: "test",
      permissionMode: "default",
      installedExtensions: [{
        id: "prefix-transform",
        name: "Prefix transform",
        description: "Adds a prefix.",
        version: "1",
        settings: [],
      }],
      defaultExtensions: [{ id: "prefix-transform" }],
      extensionDefaultsRevision: 2,
      snapshotVersion: 2,
    },
  };
}

function extensionInteraction(stage: "requested" | "resolved"): Cvp3Event {
  const common = {
    kind: "codever.event" as const,
    version: 3 as const,
    eventId: `extension-${stage}-1`,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: "session-a",
    occurredAt: stage === "requested" ? 2 : 3,
  };
  const projection = {
    title: "A",
    lifecycle: "active" as const,
    activity: "attention" as const,
    updatedAt: 2,
    stateVersion: 2,
  };
  return stage === "requested" ? {
    ...common,
    payload: {
      type: "extension.interaction.requested",
      requestId: "extension-request-1",
      extension: { id: "prefix-transform", name: "Prefix transform", version: "1" },
      cancelActionId: "cancel",
      view: {
        version: 1,
        title: "Review transformed input",
        elements: [{ type: "readonly_textarea", label: "Agent input", value: "SAFE: hello" }],
        actions: [
          { id: "continue", label: "Continue", style: "primary" },
          { id: "cancel", label: "Cancel", style: "secondary" },
        ],
      },
      projection,
    },
  } : {
    ...common,
    causationCommandId: "answer-1",
    payload: {
      type: "extension.interaction.resolved",
      requestId: "extension-request-1",
      extensionId: "prefix-transform",
      actionId: "continue",
      projection: { ...projection, activity: "working", updatedAt: 3, stateVersion: 3 },
    },
  };
}

function createCommand(suffix: string): Cvp3Command {
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
): Cvp3Event {
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

function messageEvent(index: number): Cvp3Event {
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
): Cvp3Event {
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
