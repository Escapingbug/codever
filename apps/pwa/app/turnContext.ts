import type { CommandCompletion } from "./commandLifecycle";
import type { ChatMessage } from "./chatMessages";

export type ObservedCommandCompletion = CommandCompletion & {
  observedOrder: number;
};

export type CompletedTurnContext = {
  commandId: string;
  completion: ObservedCommandCompletion;
  prompt: ChatMessage;
  promptInTranscript: ChatMessage | null;
  result: ChatMessage;
};

/**
 * Finds the newest terminal prompt whose final visible result is present in
 * the current transcript. Command completions also cover settings and session
 * operations, so the matching user prompt is the authoritative turn marker.
 */
export function latestCompletedTurnContext(
  messages: readonly ChatMessage[],
  completions: readonly ObservedCommandCompletion[],
  promptCache: ReadonlyMap<string, ChatMessage | null>,
  sessionId: string | null,
): CompletedTurnContext | null {
  if (!sessionId) return null;
  const ordered = [...completions].sort(
    (left, right) => right.observedOrder - left.observedOrder,
  );
  for (const completion of ordered) {
    if (
      completion.sessionId !== sessionId ||
      completion.outcome === "cancelled"
    ) {
      continue;
    }
    const promptInTranscript = messages.find(
      (message) =>
        message.kind === "user" && message.commandId === completion.commandId,
    ) ?? null;
    const prompt = promptInTranscript ?? promptCache.get(completion.commandId);
    if (!prompt) continue;
    const result = [...messages].reverse().find(
      (message) =>
        message.commandId === completion.commandId &&
        (message.kind === "agent" || message.kind === "error"),
    );
    if (!result) continue;
    return {
      commandId: completion.commandId,
      completion,
      prompt,
      promptInTranscript,
      result,
    };
  }
  return null;
}

export function turnPrompt(
  messages: readonly ChatMessage[],
  commandId: string,
): ChatMessage | null {
  return messages.find(
    (message) =>
      message.kind === "user" && message.commandId === commandId,
  ) ?? null;
}

export function trimHistoryPageToTurn(
  messages: readonly ChatMessage[],
  commandId: string,
): {
  messages: ChatMessage[];
  prompt: ChatMessage | null;
  hasEarlierMessages: boolean;
} {
  const promptIndex = messages.findIndex(
    (message) =>
      message.kind === "user" && message.commandId === commandId,
  );
  if (promptIndex < 0) {
    return { messages: [...messages], prompt: null, hasEarlierMessages: false };
  }
  return {
    messages: messages.slice(promptIndex),
    prompt: messages[promptIndex] ?? null,
    hasEarlierMessages: promptIndex > 0,
  };
}

/**
 * Resolves terminal commands newest-first. Known non-prompt completions are
 * skipped, but an older known task must not hide a newer unresolved command.
 */
export function nextTurnPromptLookup(
  messages: readonly ChatMessage[],
  completions: readonly ObservedCommandCompletion[],
  promptCache: ReadonlyMap<string, ChatMessage | null>,
  sessionId: string,
): ObservedCommandCompletion | null {
  const ordered = [...completions]
    .filter(
      (completion) =>
        completion.sessionId === sessionId &&
        completion.outcome !== "cancelled",
    )
    .sort((left, right) => right.observedOrder - left.observedOrder);
  for (const completion of ordered) {
    const prompt =
      turnPrompt(messages, completion.commandId) ??
      promptCache.get(completion.commandId);
    if (prompt) return null;
    if (!promptCache.has(completion.commandId)) return completion;
  }
  return null;
}
