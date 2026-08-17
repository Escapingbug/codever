import { describe, expect, it } from "vitest";
import { MatrixNativeProjection } from "./matrixNativeProjection";

describe("MatrixNativeProjection Room State", () => {
  it("builds inventory from Gateway and per-session current state", async () => {
    const projection = new MatrixNativeProjection();
    const entity = sessionState("s1", 2, {
      title: "Investigate sync",
      status: "running",
    });
    await projection.applyRoomState(gatewayState(2));
    const state = await projection.applyRoomState(entity);
    expect(state?.sessions).toMatchObject([{
      id: "s1",
      title: "Investigate sync",
      status: "running",
    }]);
  });

  it("accepts current Room State whether Gateway or session arrives first", async () => {
    const gatewayFirst = new MatrixNativeProjection();
    await expect(gatewayFirst.applyRoomState(gatewayState())).resolves.toMatchObject({
      sessions: [],
    });
    await expect(gatewayFirst.applyRoomState(sessionState("s1", 2))).resolves.toMatchObject({
      sessions: [{ id: "s1" }],
    });

    const sessionFirst = new MatrixNativeProjection();
    await expect(sessionFirst.applyRoomState(sessionState("s1", 2))).resolves.toBeNull();
    await expect(sessionFirst.applyRoomState(gatewayState())).resolves.toMatchObject({
      sessions: [{ id: "s1" }],
    });
  });

  it("publishes one complete Room State batch and rolls back invalid batches", async () => {
    const projection = new MatrixNativeProjection();
    await expect(projection.applyRoomStateBatch([
      gatewayState(2),
      sessionState("s1", 2),
      sessionState("s2", 3),
    ])).resolves.toMatchObject({
      sessions: [{ id: "s2" }, { id: "s1" }],
    });

    const before = projection.snapshot();
    await expect(projection.applyRoomStateBatch([
      tombstone("s1", 4),
      { ...sessionState("broken", 5), state: "invalid" },
    ])).rejects.toThrow();
    expect(projection.snapshot()).toEqual(before);
  });

  it("replaces one entity without scanning or replaying timeline history", async () => {
    const projection = new MatrixNativeProjection();
    const before = sessionState("s1", 2, { title: "Before" });
    const after = sessionState("s1", 3, {
      title: "After",
      status: "running",
    });
    await projection.applyRoomState(gatewayState(2));
    await projection.applyRoomState(before);
    const state = await projection.applyRoomState(after);
    expect(state?.sessions).toMatchObject([{ title: "After", status: "running" }]);
  });

  it("updates one session without waiting for an unrelated global commit", async () => {
    const projection = new MatrixNativeProjection();
    const before = sessionState("s1", 2, { title: "Before" });
    const after = sessionState("s1", 3, { title: "After" });
    await projection.applyRoomState(before);
    await projection.applyRoomState(gatewayState(2));
    await expect(projection.applyRoomState(after)).resolves.toMatchObject({
      sessions: [{ title: "After" }],
    });
  });

  it("keeps a tombstone authoritative over older session state", async () => {
    const projection = new MatrixNativeProjection();
    const current = sessionState("s1", 2);
    const deleted = tombstone("s1", 4);
    await projection.applyRoomState(gatewayState(2));
    await projection.applyRoomState(current);
    await projection.applyRoomState(deleted);
    await projection.applyRoomState(sessionState("s1", 3, { title: "Stale" }));
    expect(projection.snapshot()?.sessions).toEqual([]);
  });

  it("does not let timeline roots create inventory entities", async () => {
    const projection = new MatrixNativeProjection();
    await projection.applyRoomState(gatewayState(1));
    projection.applyTimeline({
      version: 2,
      kind: "session_root",
      ...revision(2),
      session_id: "timeline-only",
      title: "Must not appear",
      project: { id: "p1", name: "codever", cwd: "/repo" },
      created_at: 1,
      updated_at: 1,
      archived: false,
      status: "idle",
      provider: "codex",
      permission_mode: "default",
      extensions: [],
    });
    expect(projection.snapshot()?.sessions).toEqual([]);
  });

  it("advances command revision from a lightweight timeline event", async () => {
    const projection = new MatrixNativeProjection();
    await projection.applyRoomState(gatewayState(1));
    const state = projection.applyTimeline({
      version: 2,
      kind: "gateway_revision",
      ...revision(4),
      gateway_id: "g1",
      conversation_id: "c1",
      updated_at: 4,
      source_command_id: "command-4",
    });
    expect(state?.revision).toBe(4);
  });

  it("drops retired-epoch entities when Gateway generation advances", async () => {
    const projection = new MatrixNativeProjection();
    const old = sessionState("old", 2);
    await projection.applyRoomState(gatewayState(2));
    await projection.applyRoomState(old);
    await projection.applyRoomState({
      ...gatewayState(1),
      revision_epoch: "r2",
      revision_epoch_generation: 2,
      state_version: 1,
    });
    expect(projection.snapshot()?.sessions).toEqual([]);
  });

  it("allows live presentation status only for an existing Room State entity", async () => {
    const projection = new MatrixNativeProjection();
    await projection.applyRoomState(gatewayState(1));
    projection.applySessionStatus({
      kind: "status",
      session_id: "missing",
      state: "running",
    });
    expect(projection.snapshot()?.sessions).toEqual([]);
    const entity = sessionState("s1", 2);
    await projection.applyRoomState(entity);
    await projection.applyRoomState(gatewayState(2));
    expect(projection.applySessionStatus({
      kind: "status",
      session_id: "s1",
      state: "running",
      activity_phase: "working",
    })?.sessions).toMatchObject([{ status: "running", activityPhase: "working" }]);
  });
});

function gatewayState(stateVersion = 1) {
  return {
    version: 2,
    kind: "gateway_state",
    gateway_id: "g1",
    conversation_id: "c1",
    ...revision(1),
    state_version: stateVersion,
    active_device_count: 1,
    command_sequences: [
      { device_id: "device-1", sequence_epoch: "certificate-1", sequence: 0 },
    ],
    workspace: {
      project: { id: "p1", name: "codever", cwd: "/repo" },
      provider: "codex",
      permission_mode: "default",
    },
    capabilities: {
      models: [],
      permission_modes: [{ id: "default", name: "Default" }],
      can_create_session: true,
      can_select_session: false,
      can_archive_session: true,
      can_delete_session: true,
      session_extensions: [],
    },
    updated_at: 1,
  } as const;
}

function sessionState(
  sessionId: string,
  stateVersion: number,
  overrides: { title?: string; status?: "idle" | "running" } = {},
) {
  return {
    version: 2,
    kind: "session_state",
    gateway_id: "g1",
    conversation_id: "c1",
    ...revision(stateVersion),
    state_version: stateVersion,
    session_id: sessionId,
    state: "active",
    session: {
      session_id: sessionId,
      thread_root_event_id: `$${sessionId}:example.org`,
      title: overrides.title ?? sessionId,
      updated_at: stateVersion,
      archived: false,
      status: overrides.status ?? "idle",
      project: { id: "p1", name: "codever", cwd: "/repo" },
      provider: "codex",
      extensions: [],
    },
    updated_at: stateVersion,
  } as const;
}

function tombstone(sessionId: string, stateVersion: number) {
  return {
    version: 2,
    kind: "session_state",
    gateway_id: "g1",
    conversation_id: "c1",
    ...revision(stateVersion),
    state_version: stateVersion,
    session_id: sessionId,
    state: "deleted",
    updated_at: stateVersion,
  } as const;
}

function revision(value: number) {
  return {
    revision: value,
    revision_epoch: "r1",
    revision_epoch_generation: 1,
  } as const;
}
