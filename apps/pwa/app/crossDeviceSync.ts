export function shouldReconcileRecentHistory(input: {
  selectedSessionId: string | null;
  previousUpdatedAt: number | undefined;
  nextUpdatedAt: number | undefined;
}): boolean {
  return Boolean(
    input.selectedSessionId &&
      input.previousUpdatedAt !== undefined &&
      input.nextUpdatedAt !== undefined &&
      input.nextUpdatedAt > input.previousUpdatedAt,
  );
}

export function shouldRecoverVisibleHistory(input: {
  visible: boolean;
  connected: boolean;
  selectedSessionId: string | null;
  lastRecoveryAt: number;
  now: number;
  minimumIntervalMs?: number;
}): boolean {
  return Boolean(
    input.visible &&
      input.connected &&
      input.selectedSessionId &&
      input.now - input.lastRecoveryAt >= (input.minimumIntervalMs ?? 2_000),
  );
}
