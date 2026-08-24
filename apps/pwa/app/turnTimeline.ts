import type { ChatMessage } from "./chatMessages";

/**
 * The active tool group is projected into a responsive monitor outside the
 * transcript. Completed groups remain part of history, but are anchored after
 * the turn's final Agent output so they are available where review ends.
 */
export function turnTimelineMessages(
  messages: readonly ChatMessage[],
  activeToolMessageId: string | null,
): ChatMessage[] {
  const visibleMessages = messages.filter(
    (message) => message.id !== activeToolMessageId,
  );
  const toolsByResultId = new Map<string, ChatMessage[]>();
  const anchoredToolIds = new Set<string>();

  for (const toolMessage of visibleMessages) {
    if (toolMessage.kind !== "tool" || !toolMessage.toolGroup) continue;
    const turnBounds = messageTurnBounds(visibleMessages, toolMessage);
    const result = visibleMessages
      .slice(turnBounds.start, turnBounds.end)
      .filter(
        (message) =>
          message.kind === "agent" || message.kind === "error",
      )
      .at(-1);
    if (!result) continue;
    const anchored = toolsByResultId.get(result.id) ?? [];
    anchored.push(toolMessage);
    toolsByResultId.set(result.id, anchored);
    anchoredToolIds.add(toolMessage.id);
  }

  return visibleMessages.flatMap((message) => {
    if (anchoredToolIds.has(message.id)) return [];
    return [message, ...(toolsByResultId.get(message.id) ?? [])];
  });
}

export function activeTurnToolMessage(
  messages: readonly ChatMessage[],
  running: boolean,
): ChatMessage | null {
  if (!running) return null;
  const latestPromptIndex = messages.findLastIndex(
    (message) => message.kind === "user",
  );
  const latestPrompt = messages[latestPromptIndex];
  return messages
    .slice(Math.max(0, latestPromptIndex + 1))
    .filter(
      (message) =>
        message.kind === "tool" &&
        message.toolGroup &&
        (!latestPrompt?.commandId ||
          !message.commandId ||
          message.commandId === latestPrompt.commandId),
    )
    .at(-1) ?? null;
}

function messageTurnBounds(
  messages: readonly ChatMessage[],
  target: ChatMessage,
): { start: number; end: number } {
  if (target.commandId) {
    const matchingIndexes = messages.flatMap((message, index) =>
      message.commandId === target.commandId ? [index] : [],
    );
    if (matchingIndexes.length > 0) {
      return {
        start: matchingIndexes[0],
        end: matchingIndexes.at(-1)! + 1,
      };
    }
  }

  const targetIndex = messages.findIndex(
    (message) => message.id === target.id,
  );
  let start = 0;
  for (let index = targetIndex; index >= 0; index -= 1) {
    if (messages[index]?.kind === "user") {
      start = index;
      break;
    }
  }
  const nextPromptOffset = messages
    .slice(targetIndex + 1)
    .findIndex((message) => message.kind === "user");
  return {
    start,
    end:
      nextPromptOffset < 0
        ? messages.length
        : targetIndex + 1 + nextPromptOffset,
  };
}
