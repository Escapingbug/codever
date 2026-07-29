import type { PersistedChatMessage } from "./messageHistory";

export type ChatMessage = PersistedChatMessage & {
  sessionId?: string;
  historical?: boolean;
  optimistic?: boolean;
};

export type OptimisticMessageReference = {
  id: string;
  text: string;
  sessionId?: string;
  commandId?: string;
};

export function findOptimisticMessageId(
  references: Iterable<OptimisticMessageReference>,
  incoming: Pick<ChatMessage, "text" | "sessionId" | "commandId">,
): string | undefined {
  const candidates = [...references];
  if (incoming.commandId) {
    const exact = candidates.find(
      (candidate) => candidate.commandId === incoming.commandId,
    );
    if (exact) return exact.id;
  }
  return candidates
    .reverse()
    .find(
      (candidate) =>
        candidate.text === incoming.text &&
        candidate.sessionId === incoming.sessionId,
    )?.id;
}

export function mergeChatMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  return [...incoming]
    .sort(compareChatMessages)
    .reduce<ChatMessage[]>(
      (messages, message) => mergeChatMessage(messages, message),
      [...current],
    );
}

export function mergeChatMessage(
  current: readonly ChatMessage[],
  message: ChatMessage,
  options: {
    reconcileMessageId?: string;
  } = {},
): ChatMessage[] {
  const reconcileIndex = options.reconcileMessageId
    ? current.findIndex((entry) => entry.id === options.reconcileMessageId)
    : -1;
  if (reconcileIndex >= 0) {
    return replaceAndReorder(current, reconcileIndex, {
      ...current[reconcileIndex],
      ...message,
      id: current[reconcileIndex].id,
      optimistic: false,
    });
  }

  if (current.some((entry) => entry.id === message.id)) return [...current];

  const commandIndex = message.commandId
    ? current.findIndex((entry) => entry.commandId === message.commandId)
    : -1;
  if (commandIndex >= 0) {
    const existing = current[commandIndex];
    if (existing.kind !== "user" || message.kind !== "user") {
      return [...current];
    }
    const existingIsCanonical = Boolean(existing.eventId);
    const incomingIsCanonical = Boolean(message.eventId);
    if (existingIsCanonical && !incomingIsCanonical) return [...current];
    if (!incomingIsCanonical && !message.optimistic) return [...current];
    return replaceAndReorder(current, commandIndex, {
      ...existing,
      ...message,
      id: existing.id,
      optimistic: !incomingIsCanonical && message.optimistic,
    });
  }

  const replaceIndex = message.replacesEventId
    ? current.findIndex(
        (entry) =>
          entry.eventId === message.replacesEventId ||
          entry.id === message.replacesEventId,
      )
    : -1;
  const streamIndex = message.streamId
    ? current.findIndex((entry) => entry.streamId === message.streamId)
    : -1;
  const targetIndex = replaceIndex >= 0 ? replaceIndex : streamIndex;
  if (targetIndex >= 0) {
    const existing = current[targetIndex];
    const text =
      message.raw?.type === "agent.text.delta" &&
      existing.text !== message.text
        ? `${existing.text ?? ""}${message.text ?? ""}`
        : message.text;
    const next = [...current];
    next[targetIndex] = {
      ...message,
      id: existing.id,
      eventId: message.eventId ?? existing.eventId,
      // A Matrix edit or stream delta updates one logical message. Preserve
      // the first event's timeline position instead of moving the bubble to
      // every later update timestamp.
      timestamp: existing.timestamp ?? message.timestamp,
      time: existing.time ?? message.time,
      text,
    };
    return next;
  }

  return insertChatMessage(current, message);
}

export function compareChatMessages(
  left: Pick<ChatMessage, "timestamp" | "id">,
  right: Pick<ChatMessage, "timestamp" | "id">,
): number {
  return (
    (left.timestamp ?? Number.MAX_SAFE_INTEGER) -
      (right.timestamp ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  );
}

function replaceAndReorder(
  current: readonly ChatMessage[],
  index: number,
  message: ChatMessage,
): ChatMessage[] {
  const next = [...current];
  next.splice(index, 1);
  return insertChatMessage(next, message);
}

function insertChatMessage(
  current: readonly ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const next = [...current];
  const laterIndex = next.findIndex((entry) => {
    if (
      message.kind === "user" &&
      message.revision !== undefined &&
      entry.kind === "user" &&
      entry.revision !== undefined
    ) {
      return entry.revision > message.revision;
    }
    return (
      message.timestamp !== undefined &&
      entry.timestamp !== undefined &&
      compareChatMessages(entry, message) > 0
    );
  });
  if (laterIndex >= 0) next.splice(laterIndex, 0, message);
  else next.push(message);
  return next;
}
