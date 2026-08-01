import type { PersistedChatMessage } from "./messageHistory";

export type ChatMessage = PersistedChatMessage & {
  sessionId?: string;
  historical?: boolean;
  optimistic?: boolean;
  eventAliases?: string[];
  mergedOperationIds?: string[];
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

  const exactIndex = current.findIndex((entry) => entry.id === message.id);
  const operationIndex = findOperationIndex(current, message);
  if (operationIndex >= 0) {
    return mergeLogicalCopies(current, operationIndex, message);
  }
  if (exactIndex >= 0) return [...current];

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
    const timelineCopy = preferredTimelineCopy(existing, message);
    return replaceAndReorder(current, commandIndex, {
      ...existing,
      ...message,
      id: existing.id,
      timestamp: timelineCopy.timestamp ?? existing.timestamp ?? message.timestamp,
      time: timelineCopy.time ?? existing.time ?? message.time,
      raw: preferredTimelineRaw(timelineCopy, message),
      optimistic: !incomingIsCanonical && message.optimistic,
    });
  }

  const replacementTarget = message.replacesEventId;
  const replaceIndex = replacementTarget
    ? current.findIndex(
        (entry) =>
          entry.eventId === replacementTarget ||
          entry.id === replacementTarget ||
          entry.eventAliases?.includes(replacementTarget),
      )
    : -1;
  const streamIndex = message.streamId
    ? current.findIndex((entry) => entry.streamId === message.streamId)
    : -1;
  const toolIndex = message.toolCallId
    ? current.findIndex((entry) => entry.toolCallId === message.toolCallId)
    : -1;
  const targetIndex =
    replaceIndex >= 0
      ? replaceIndex
      : streamIndex >= 0
        ? streamIndex
        : toolIndex;
  if (targetIndex >= 0) {
    const existing = current[targetIndex];
    if (
      existing.toolCallId &&
      existing.toolCallId === message.toolCallId &&
      !shouldApplyToolStatusUpdate(
        existing.toolStatus,
        message.toolStatus,
      )
    ) {
      return [...current];
    }
    if (message.raw?.type === "agent.tool.completed") {
      const next = [...current];
      next[targetIndex] = {
        ...existing,
        ...message,
        id: existing.id,
        eventAliases: mergeEventAliases(existing, message),
        mergedOperationIds: mergeOperationIds(existing, message),
        text: existing.text || message.text,
        raw: { ...(existing.raw ?? {}), ...(message.raw ?? {}) },
        timestamp: existing.timestamp ?? message.timestamp,
        time: existing.time ?? message.time,
      };
      return next;
    }
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
      eventAliases: mergeEventAliases(existing, message),
      mergedOperationIds: mergeOperationIds(existing, message),
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

function findOperationIndex(
  current: readonly ChatMessage[],
  message: ChatMessage,
): number {
  const incoming = new Set(operationIds(message));
  if (incoming.size === 0) return -1;
  return current.findIndex((entry) =>
    operationIds(entry).some((operationId) => incoming.has(operationId)),
  );
}

function mergeLogicalCopies(
  current: readonly ChatMessage[],
  index: number,
  message: ChatMessage,
): ChatMessage[] {
  const existing = current[index];
  const preferred = preferredLogicalCopy(existing, message);
  const timelineCopy = preferredTimelineCopy(existing, message);
  const liveCopy = !existing.historical
    ? existing
    : !message.historical
      ? message
      : undefined;
  const next = [...current];
  next[index] = {
    ...existing,
    ...preferred,
    id: existing.id,
    eventId:
      liveCopy?.eventId ?? preferred.eventId ?? existing.eventId ?? message.eventId,
    eventAliases: mergeEventAliases(existing, message),
    mergedOperationIds: mergeOperationIds(existing, message),
    timestamp: timelineCopy.timestamp ?? existing.timestamp ?? message.timestamp,
    time: timelineCopy.time ?? existing.time ?? message.time,
    raw: preferredTimelineRaw(timelineCopy, preferred),
    historical: Boolean(existing.historical && message.historical),
  };
  return next;
}

function preferredTimelineCopy(
  existing: ChatMessage,
  incoming: ChatMessage,
): ChatMessage {
  // Gateway recovery carries the original outbox timestamp. A Matrix timeline
  // copy carries its later homeserver arrival timestamp, so mixing the two can
  // place a fast agent reply before the user prompt that caused it.
  const existingRank = timelineAuthorityRank(existing);
  const incomingRank = timelineAuthorityRank(incoming);
  return incomingRank > existingRank ? incoming : existing;
}

function timelineAuthorityRank(message: ChatMessage): number {
  if (isGatewayHistoryCopy(message)) return 2;
  if (message.eventId) return 1;
  return 0;
}

function isGatewayHistoryCopy(message: ChatMessage): boolean {
  const marker = message.raw?.history_replay;
  return Boolean(
    marker &&
      typeof marker === "object" &&
      !Array.isArray(marker) &&
      (marker as Record<string, unknown>).display_only === true,
  );
}

function preferredTimelineRaw(
  timelineCopy: ChatMessage,
  contentCopy: ChatMessage,
): Record<string, unknown> | undefined {
  if (!isGatewayHistoryCopy(timelineCopy)) return contentCopy.raw;
  return {
    ...(contentCopy.raw ?? {}),
    ...(timelineCopy.raw ?? {}),
  };
}

function preferredLogicalCopy(
  existing: ChatMessage,
  incoming: ChatMessage,
): ChatMessage {
  const existingOperations = new Set(operationIds(existing));
  const incomingOperations = new Set(operationIds(incoming));
  const incomingAddsOperations = [...incomingOperations].some(
    (operationId) => !existingOperations.has(operationId),
  );
  const existingAddsOperations = [...existingOperations].some(
    (operationId) => !incomingOperations.has(operationId),
  );
  if (incomingAddsOperations && !existingAddsOperations) return incoming;
  if (existingAddsOperations && !incomingAddsOperations) return existing;
  if (existing.historical !== incoming.historical) {
    return existing.historical ? incoming : existing;
  }
  return latestToolUpdate(incoming) > latestToolUpdate(existing)
    ? incoming
    : existing;
}

function latestToolUpdate(message: ChatMessage): number {
  return Math.max(
    0,
    ...(message.toolGroup?.tools.map((tool) => tool.updatedAt) ?? []),
  );
}

function mergeEventAliases(
  existing: ChatMessage,
  incoming: ChatMessage,
): string[] {
  return uniqueStrings([
    existing.id,
    existing.eventId,
    ...(existing.eventAliases ?? []),
    incoming.id,
    incoming.eventId,
    ...(incoming.eventAliases ?? []),
  ]);
}

function mergeOperationIds(
  existing: ChatMessage,
  incoming: ChatMessage,
): string[] {
  return uniqueStrings([...operationIds(existing), ...operationIds(incoming)]);
}

function operationIds(message: ChatMessage): string[] {
  return uniqueStrings([
    message.operationId,
    ...(message.mergedOperationIds ?? []),
  ]);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
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

function shouldApplyToolStatusUpdate(
  current: "running" | "succeeded" | "failed" | undefined,
  incoming: "running" | "succeeded" | "failed" | undefined,
): boolean {
  const currentIsTerminal = current === "succeeded" || current === "failed";
  return !(currentIsTerminal && incoming === "running");
}
