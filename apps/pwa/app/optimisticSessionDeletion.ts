export function setSessionOptimisticallyDeleted(
  current: ReadonlySet<string>,
  sessionId: string,
  deleted: boolean,
): Set<string> {
  const next = new Set(current);
  if (deleted) next.add(sessionId);
  else next.delete(sessionId);
  return next;
}

export function reconcileOptimisticSessionDeletions(
  current: ReadonlySet<string>,
  authoritativeSessionIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...current].filter((sessionId) => authoritativeSessionIds.has(sessionId)),
  );
}
