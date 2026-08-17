import type { PersistedChatMessage } from "./messageHistory";

type TranscriptCandidate = {
  kind?: string;
  text?: string;
  format?: string;
  replacesEventId?: string;
  attachments?: readonly unknown[];
  raw?: Record<string, unknown>;
};

export function isTransientAgentLifecycleEvent(
  raw: Record<string, unknown> | undefined,
): boolean {
  return Boolean(
    raw &&
      raw.kind === "status",
  );
}

export function isTranscriptMessage(message: TranscriptCandidate): boolean {
  if (message.kind === "error") return true;
  return !isTransientAgentLifecycleEvent(message.raw);
}

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

export function isAgentWorkMessage(
  message: Pick<ChatMessage, "kind"> | undefined,
): boolean {
  return message?.kind === "agent" || message?.kind === "tool";
}

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
  if (!isTranscriptMessage(message)) {
    const replacementTarget = message.replacesEventId;
    return replacementTarget
      ? current.filter(
          (entry) =>
            entry.eventId !== replacementTarget &&
            entry.id !== replacementTarget &&
            !entry.eventAliases?.includes(replacementTarget),
        )
      : [...current];
  }

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
  if (exactIndex >= 0) {
    return mergeLogicalCopies(current, exactIndex, message);
  }

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
      raw: message.raw,
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
  const targetIndex = replaceIndex;
  if (targetIndex >= 0) {
    const existing = current[targetIndex];
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
      text: message.text,
      toolGroup: mergeToolGroupPresentation(
        existing.toolGroup,
        message.toolGroup,
      ),
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
    raw: preferred.raw,
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
  if (message.eventId) return 1;
  return 0;
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
    if (message.kind === "user" && entry.kind === "user") {
      const revisionOrder = compareUserRevisionOrder(entry, message);
      if (revisionOrder !== null && revisionOrder !== 0) {
        return revisionOrder > 0;
      }
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

type UserRevisionOrder = {
  revision: number;
  epoch: string;
  generation?: number;
};

/**
 * Revisions are monotonic only inside one Gateway revision epoch. An epoch
 * rotation resets the revision counter, so comparing the bare numbers can
 * move a newly resumed prompt far back into an older conversation. Epoch
 * generation orders modern messages across rotations; incomplete legacy
 * metadata deliberately falls back to the Matrix timestamp.
 */
function compareUserRevisionOrder(
  left: ChatMessage,
  right: ChatMessage,
): number | null {
  const leftOrder = userRevisionOrder(left);
  const rightOrder = userRevisionOrder(right);
  if (!leftOrder || !rightOrder) return null;

  if (leftOrder.epoch === rightOrder.epoch) {
    if (
      leftOrder.generation !== undefined &&
      rightOrder.generation !== undefined &&
      leftOrder.generation !== rightOrder.generation
    ) {
      return null;
    }
    return leftOrder.revision - rightOrder.revision;
  }
  if (
    leftOrder.generation !== undefined &&
    rightOrder.generation !== undefined &&
    leftOrder.generation !== rightOrder.generation
  ) {
    return leftOrder.generation - rightOrder.generation;
  }
  return null;
}

function userRevisionOrder(message: ChatMessage): UserRevisionOrder | null {
  if (
    message.revision === undefined ||
    !Number.isSafeInteger(message.revision) ||
    message.revision < 0
  ) {
    return null;
  }
  const epoch = message.raw?.revision_epoch;
  if (typeof epoch !== "string" || !epoch) return null;
  const candidateGeneration = message.raw?.revision_epoch_generation;
  const generation =
    typeof candidateGeneration === "number" &&
    Number.isSafeInteger(candidateGeneration) &&
    candidateGeneration > 0
      ? candidateGeneration
      : undefined;
  return {
    revision: message.revision,
    epoch,
    ...(generation === undefined ? {} : { generation }),
  };
}

function mergeToolGroupPresentation(
  current: ChatMessage["toolGroup"],
  incoming: ChatMessage["toolGroup"],
): ChatMessage["toolGroup"] {
  if (!current || !incoming || current.groupId !== incoming.groupId) {
    return incoming ?? current;
  }
  const tools = new Map(current.tools.map((tool) => [tool.id, tool]));
  for (const candidate of incoming.tools) {
    const existing = tools.get(candidate.id);
    if (!existing) {
      tools.set(candidate.id, candidate);
      continue;
    }
    if (
      toolPhaseRank(candidate.phase) < toolPhaseRank(existing.phase) ||
      candidate.updatedAt < existing.updatedAt
    ) {
      continue;
    }
    tools.set(candidate.id, {
      ...existing,
      ...candidate,
      startedAt: Math.min(existing.startedAt, candidate.startedAt),
      updatedAt: Math.max(existing.updatedAt, candidate.updatedAt),
    });
  }
  return { ...incoming, tools: [...tools.values()] };
}

function toolPhaseRank(
  phase: "started" | "updated" | "completed" | "failed",
): number {
  switch (phase) {
    case "started": return 0;
    case "updated": return 1;
    case "completed":
    case "failed":
      return 2;
  }
}
