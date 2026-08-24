import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chatMessages";
import {
  activeTurnToolMessage,
  turnTimelineMessages,
} from "./turnTimeline";

describe("turnTimelineMessages", () => {
  it("anchors completed activity after the final Agent output", () => {
    const messages = [
      message("prompt", "user", "turn-1"),
      message("progress-1", "agent", "turn-1"),
      toolMessage("tools", "turn-1"),
      message("progress-2", "agent", "turn-1"),
      message("result", "agent", "turn-1"),
    ];

    expect(turnTimelineMessages(messages, null).map(({ id }) => id)).toEqual([
      "prompt",
      "progress-1",
      "progress-2",
      "result",
      "tools",
    ]);
  });

  it("removes active activity from the transcript for separate monitoring", () => {
    const messages = [
      message("prompt", "user", "turn-1"),
      message("progress", "agent", "turn-1"),
      toolMessage("tools", "turn-1"),
    ];

    expect(turnTimelineMessages(messages, "tools").map(({ id }) => id)).toEqual([
      "prompt",
      "progress",
    ]);
  });

  it("keeps multiple completed groups in their original order", () => {
    const messages = [
      message("prompt", "user", "turn-1"),
      toolMessage("tools-1", "turn-1"),
      message("progress", "agent", "turn-1"),
      toolMessage("tools-2", "turn-1"),
      message("result", "agent", "turn-1"),
    ];

    expect(turnTimelineMessages(messages, null).map(({ id }) => id)).toEqual([
      "prompt",
      "progress",
      "result",
      "tools-1",
      "tools-2",
    ]);
  });

  it("falls back to prompt boundaries for legacy history", () => {
    const messages = [
      message("prompt", "user"),
      toolMessage("tools"),
      message("result", "agent"),
      message("next-prompt", "user"),
    ];

    expect(turnTimelineMessages(messages, null).map(({ id }) => id)).toEqual([
      "prompt",
      "result",
      "tools",
      "next-prompt",
    ]);
  });
});

describe("activeTurnToolMessage", () => {
  it("only selects activity belonging to the currently running prompt", () => {
    const messages = [
      message("prompt-1", "user", "turn-1"),
      toolMessage("tools-1", "turn-1"),
      message("result-1", "agent", "turn-1"),
      message("prompt-2", "user", "turn-2"),
    ];

    expect(activeTurnToolMessage(messages, true)).toBeNull();
    expect(
      activeTurnToolMessage(
        [...messages, toolMessage("tools-2", "turn-2")],
        true,
      )?.id,
    ).toBe("tools-2");
    expect(
      activeTurnToolMessage(
        [...messages, toolMessage("tools-2", "turn-2")],
        false,
      ),
    ).toBeNull();
  });
});

function message(
  id: string,
  kind: ChatMessage["kind"],
  commandId?: string,
): ChatMessage {
  return { id, kind, commandId, text: id, timestamp: id.length };
}

function toolMessage(id: string, commandId?: string): ChatMessage {
  return {
    ...message(id, "tool", commandId),
    toolGroup: {
      kind: "tool_group",
      version: 1,
      groupId: id,
      tools: [
        {
          id: `${id}-read`,
          name: "Read",
          title: "Read",
          detail: "src/index.ts",
          category: "read",
          phase: "completed",
          isError: false,
          startedAt: 1,
          updatedAt: 2,
        },
      ],
    },
  };
}
