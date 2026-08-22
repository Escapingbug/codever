import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chatMessages";
import {
  latestCompletedTurnContext,
  nextTurnPromptLookup,
  trimHistoryPageToTurn,
  type ObservedCommandCompletion,
} from "./turnContext";

function message(
  id: string,
  kind: ChatMessage["kind"],
  commandId: string,
): ChatMessage {
  return { id, kind, commandId, timestamp: Number(id.replace(/\D/g, "")) };
}

function completion(
  commandId: string,
  observedOrder: number,
  sessionId = "session-a",
): ObservedCommandCompletion {
  return {
    commandId,
    observedOrder,
    sessionId,
    sequence: 1,
    revision: 1,
    outcome: "succeeded",
  };
}

describe("latestCompletedTurnContext", () => {
  it("pairs a terminal result with its causal prompt", () => {
    const messages = [
      message("message-1", "user", "turn-a"),
      message("message-2", "agent", "turn-a"),
    ];

    const context = latestCompletedTurnContext(
      messages,
      [completion("turn-a", 1)],
      new Map(),
      "session-a",
    );

    expect(context?.prompt.id).toBe("message-1");
    expect(context?.result.id).toBe("message-2");
  });

  it("uses a cached prompt while its transcript page is still loading", () => {
    const cachedPrompt = message("message-1", "user", "turn-a");
    const context = latestCompletedTurnContext(
      [message("message-50", "agent", "turn-a")],
      [completion("turn-a", 1)],
      new Map([["turn-a", cachedPrompt]]),
      "session-a",
    );

    expect(context?.prompt).toBe(cachedPrompt);
    expect(context?.promptInTranscript).toBeNull();
  });

  it("ignores newer non-prompt command completions", () => {
    const messages = [
      message("message-1", "user", "turn-a"),
      message("message-2", "agent", "turn-a"),
    ];
    const context = latestCompletedTurnContext(
      messages,
      [completion("turn-a", 1), completion("session-update", 2)],
      new Map([["session-update", null]]),
      "session-a",
    );

    expect(context?.commandId).toBe("turn-a");
  });

  it("does not reuse a completion from another session", () => {
    const messages = [
      message("message-1", "user", "turn-a"),
      message("message-2", "agent", "turn-a"),
    ];
    expect(
      latestCompletedTurnContext(
        messages,
        [completion("turn-a", 1, "session-b")],
        new Map(),
        "session-a",
      ),
    ).toBeNull();
  });

  it("stops a hydrated history page at the current turn prompt", () => {
    const previousTurn = message("message-1", "agent", "turn-previous");
    const prompt = message("message-2", "user", "turn-a");
    const result = message("message-3", "agent", "turn-a");

    const page = trimHistoryPageToTurn(
      [previousTurn, prompt, result],
      "turn-a",
    );

    expect(page.messages).toEqual([prompt, result]);
    expect(page.prompt).toBe(prompt);
    expect(page.hasEarlierMessages).toBe(true);
  });

  it("resolves a newer unknown completion before an older cached task", () => {
    const olderPrompt = message("message-1", "user", "turn-a");
    const unresolved = nextTurnPromptLookup(
      [],
      [completion("turn-a", 1), completion("new-command", 2)],
      new Map([["turn-a", olderPrompt]]),
      "session-a",
    );

    expect(unresolved?.commandId).toBe("new-command");
  });
});
