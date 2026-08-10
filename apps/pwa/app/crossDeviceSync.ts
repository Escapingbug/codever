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
