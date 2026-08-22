export function setSessionDeletionPending(
  current: ReadonlySet<string>,
  sessionId: string,
  pending: boolean,
): Set<string> {
  const next = new Set(current);
  if (pending) next.add(sessionId);
  else next.delete(sessionId);
  return next;
}

export function reconcilePendingSessionDeletions(
  current: ReadonlySet<string>,
  authoritativeSessionIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...current].filter((sessionId) => authoritativeSessionIds.has(sessionId)),
  );
}

export function sessionsAvailableForAutomaticSelection<T extends { id: string }>(
  sessions: readonly T[],
  pendingLifecycleSessionIds: ReadonlySet<string>,
): T[] {
  return sessions.filter(
    (session) => !pendingLifecycleSessionIds.has(session.id),
  );
}

export function pendingSessionLifecycleIds(
  actions: ReadonlyMap<string, unknown>,
): Set<string> {
  return new Set(actions.keys());
}
