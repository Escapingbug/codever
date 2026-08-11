import { describe, expect, it } from "vitest";
import type { MatrixNativeContent } from "@codever/protocol";
import { canonicalSessionCommandResult } from "./canonicalCommandCompletion";

const revision = {
  version: 2 as const,
  revision: 7,
  revision_epoch: "epoch-1",
  revision_epoch_generation: 1,
};

describe("canonical session command completion", () => {
  it("accepts only the state transition owned by the matching operation", () => {
    expect(canonicalSessionCommandResult(
      { operation: "session.archive", sessionId: "session-1" },
      lifecycle("archived"),
    )).toBe("session-1");
    expect(canonicalSessionCommandResult(
      { operation: "session.restore", sessionId: "session-1" },
      lifecycle("idle"),
    )).toBe("session-1");
    expect(canonicalSessionCommandResult(
      { operation: "session.delete", sessionId: "session-1" },
      lifecycle("deleted"),
    )).toBe("session-1");
    expect(canonicalSessionCommandResult(
      { operation: "session.delete", sessionId: "session-1" },
      lifecycle("archived"),
    )).toBeNull();
    expect(canonicalSessionCommandResult(
      { operation: "session.archive", sessionId: "session-other" },
      lifecycle("archived"),
    )).toBeNull();
  });

  it("accepts create roots and settings updates but never prompt updates", () => {
    const root: MatrixNativeContent = {
      ...revision,
      kind: "session_root",
      session_id: "session-new",
      title: "New session",
      project: { id: "project-1", name: "codever", cwd: "/srv/codever" },
      created_at: 10,
      updated_at: 10,
      archived: false,
      status: "idle",
      provider: "codex",
      permission_mode: "default",
      extensions: [],
      source_command_id: "command-create",
    };
    const update: MatrixNativeContent = {
      ...revision,
      kind: "session_update",
      session_id: "session-new",
      updated_at: 11,
      title: "Updated",
      source_command_id: "command-update",
    };
    expect(canonicalSessionCommandResult(
      { operation: "session.create" },
      root,
    )).toBe("session-new");
    expect(canonicalSessionCommandResult(
      { operation: "session.settings", sessionId: "session-new" },
      update,
    )).toBe("session-new");
    expect(canonicalSessionCommandResult(
      { operation: "prompt", sessionId: "session-new", text: "hello" },
      update,
    )).toBeNull();
  });
});

function lifecycle(
  state: "idle" | "running" | "stopping" | "failed" | "archived" | "deleted",
): MatrixNativeContent {
  return {
    ...revision,
    kind: "session_lifecycle",
    session_id: "session-1",
    state,
    updated_at: 12,
    source_command_id: "command-1",
  };
}
