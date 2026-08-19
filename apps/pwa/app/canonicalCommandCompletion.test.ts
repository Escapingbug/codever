import { describe, expect, it } from "vitest";
import type { MatrixSessionState } from "@codever/protocol";
import { canonicalSessionCommandResult } from "./canonicalCommandCompletion";

const revision = {
  version: 2 as const,
  revision: 7,
  revision_epoch: "epoch-1",
  revision_epoch_generation: 1,
};

describe("canonical session command completion", () => {
  it("accepts only the authoritative Room State transition owned by the command", () => {
    expect(canonicalSessionCommandResult(
      { operation: "session.archive", sessionId: "session-new" },
      sessionState("archived"),
      "archived",
    )).toBe("session-new");
    expect(canonicalSessionCommandResult(
      { operation: "session.restore", sessionId: "session-new" },
      sessionState("active"),
      "active",
    )).toBe("session-new");
    expect(canonicalSessionCommandResult(
      { operation: "session.delete", sessionId: "session-new" },
      sessionState("deleted"),
      "deleted",
    )).toBe("session-new");
    expect(canonicalSessionCommandResult(
      { operation: "session.delete", sessionId: "session-new" },
      sessionState("archived"),
      "archived",
    )).toBeNull();
    expect(canonicalSessionCommandResult(
      { operation: "session.archive", sessionId: "session-other" },
      sessionState("archived"),
      "archived",
    )).toBeNull();
  });

  it("accepts create and settings only after their entity won projection ordering", () => {
    expect(canonicalSessionCommandResult(
      { operation: "session.create" },
      sessionState("active"),
      "active",
    )).toBe("session-new");
    expect(canonicalSessionCommandResult(
      { operation: "session.settings", sessionId: "session-new" },
      sessionState("active"),
      "active",
    )).toBe("session-new");
    expect(canonicalSessionCommandResult(
      { operation: "prompt", sessionId: "session-new", text: "hello" },
      sessionState("active"),
      "active",
    )).toBeNull();
  });

  it("does not complete from a stale tombstone rejected by projection", () => {
    expect(canonicalSessionCommandResult(
      { operation: "session.delete", sessionId: "session-new" },
      sessionState("deleted"),
      "active",
    )).toBeNull();
  });
});

function sessionState(
  state: "active" | "archived" | "deleted",
): MatrixSessionState {
  return {
    ...revision,
    kind: "session_state",
    gateway_id: "gateway-1",
    conversation_id: "conversation-1",
    state_version: 14,
    session_id: "session-new",
    state,
    ...(state === "deleted"
      ? {}
      : {
          session: {
            session_id: "session-new",
            title: "New session",
            updated_at: 12,
            archived: state === "archived",
            status: "idle" as const,
            project: { id: "project-1", name: "Codever", cwd: "/codever" },
            provider: "codex",
            extensions: [],
          },
        }),
    updated_at: 12,
    source_command_id: "command-1",
  };
}
