import { describe, expect, it } from "vitest";
import { MatrixNativeProjection } from "./matrixNativeProjection";

describe("MatrixNativeProjection", () => {
  it("rebuilds session inventory from roots and lifecycle deltas", () => {
    const projection = new MatrixNativeProjection();
    projection.apply(checkpoint());
    projection.apply({
      version: 2,
      kind: "session_root",
      ...revision(1),
      session_id: "s1",
      title: "Investigate sync",
      project: { id: "p1", name: "codever", cwd: "/repo" },
      created_at: 1,
      updated_at: 1,
      archived: false,
      status: "running",
      provider: "codex",
      permission_mode: "default",
      extensions: [],
    });
    const state = projection.snapshot();
    expect(state?.sessions).toMatchObject([{ id: "s1", status: "running" }]);
    expect(projection.apply({
      version: 2,
      kind: "session_lifecycle",
      ...revision(2),
      session_id: "s1",
      state: "archived",
      updated_at: 2,
    })?.sessions[0]?.status).toBe("archived");
    expect(projection.apply({
      version: 2,
      kind: "session_lifecycle",
      ...revision(3),
      session_id: "s1",
      state: "deleted",
      updated_at: 3,
    })?.sessions).toEqual([]);
    expect(projection.snapshot()?.revision).toBe(3);
  });

  it("bootstraps sessions from the latest checkpoint without historical roots", () => {
    const projection = new MatrixNativeProjection();
    const state = projection.apply({
      ...checkpoint(),
      sessions: [{
        session_id: "s-existing",
        title: "Existing work",
        updated_at: 7,
        archived: false,
        status: "idle" as const,
        project: { id: "p1", name: "codever", cwd: "/repo" },
        provider: "codex",
        extensions: [],
      }],
    });

    expect(state?.sessions).toMatchObject([{
      id: "s-existing",
      title: "Existing work",
      projectName: "codever",
    }]);
  });

  it("does not let a duplicate checkpoint erase newer session roots", () => {
    const projection = new MatrixNativeProjection();
    const initial = {
      ...checkpoint(),
      sessions: [{
        session_id: "s-existing",
        title: "Existing work",
        updated_at: 7,
        archived: false,
        status: "idle" as const,
        project: { id: "p1", name: "codever", cwd: "/repo" },
        provider: "codex",
        extensions: [],
      }],
    };
    projection.apply(initial);
    projection.apply({
      version: 2,
      kind: "session_root",
      ...revision(2),
      session_id: "s-new",
      title: "New work",
      project: { id: "p2", name: "another", cwd: "/another" },
      created_at: 8,
      updated_at: 8,
      archived: false,
      status: "idle",
      provider: "codex",
      permission_mode: "default",
      extensions: [],
    });

    const replayed = projection.apply(initial);

    expect(replayed?.sessions.map((session) => session.id).sort()).toEqual([
      "s-existing",
      "s-new",
    ]);
  });

  it("replays updates that arrive before their thread root", () => {
    const projection = new MatrixNativeProjection();
    projection.apply(checkpoint());
    projection.apply({
      version: 2,
      kind: "session_update",
      ...revision(2),
      session_id: "s1",
      updated_at: 3,
      title: "Recovered title",
      model: null,
    });
    projection.apply({
      version: 2,
      kind: "session_lifecycle",
      ...revision(3),
      session_id: "s1",
      state: "archived",
      updated_at: 4,
    });

    const state = projection.apply({
      version: 2,
      kind: "session_root",
      ...revision(1),
      session_id: "s1",
      title: "Initial title",
      project: { id: "p1", name: "codever", cwd: "/repo" },
      created_at: 1,
      updated_at: 1,
      archived: false,
      status: "idle",
      provider: "codex",
      model: "old-model",
      permission_mode: "default",
      extensions: [],
    });

    expect(state?.sessions).toMatchObject([{
      id: "s1",
      title: "Recovered title",
      status: "archived",
    }]);
    expect(state?.sessions[0]).not.toHaveProperty("model");
  });

  it("does not resurrect a session deleted before its root is fetched", () => {
    const projection = new MatrixNativeProjection();
    projection.apply(checkpoint());
    projection.apply({
      version: 2,
      kind: "session_lifecycle",
      ...revision(2),
      session_id: "s1",
      state: "deleted",
      updated_at: 4,
    });
    expect(projection.apply({
      version: 2,
      kind: "session_root",
      ...revision(1),
      session_id: "s1",
      title: "Deleted session",
      project: { id: "p1", name: "codever", cwd: "/repo" },
      created_at: 1,
      updated_at: 1,
      archived: false,
      status: "idle",
      provider: "codex",
      permission_mode: "default",
      extensions: [],
    })?.sessions).toEqual([]);
  });

  it("advances revision from a lightweight room timeline event", () => {
    const projection = new MatrixNativeProjection();
    projection.apply(checkpoint());
    const state = projection.apply({
      version: 2,
      kind: "gateway_revision",
      ...revision(4),
      gateway_id: "g1",
      conversation_id: "c1",
      updated_at: 4,
      source_command_id: "command-4",
    });
    expect(state?.revision).toBe(4);
    expect(state?.sessions).toEqual([]);
  });
});

function checkpoint() {
  return {
    version: 2,
    kind: "gateway_checkpoint",
    gateway_id: "g1",
    conversation_id: "c1",
    revision: 1,
    revision_epoch: "r1",
    revision_epoch_generation: 1,
    state_version: 1,
    active_device_count: 1,
    sessions: [],
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

function revision(value: number) {
  return {
    revision: value,
    revision_epoch: "r1",
    revision_epoch_generation: 1,
  } as const;
}
