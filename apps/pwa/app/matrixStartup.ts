export const MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS = 45_000;

export const MATRIX_STARTUP_BACKGROUND_RECOVERY_MS = 5_000;

export const MATRIX_STARTUP_FOREGROUND_BUDGET_MS = 60_000;

export const MATRIX_STARTUP_RECOVERY_SESSION_KEY =
  "codever.matrix.startup-recovery.v1";

export const MATRIX_CRYPTO_LOADING_DETAIL =
  "Loading end-to-end encryption… The first load downloads several megabytes and is limited to 45 seconds before Codever offers a clean retry.";

export const MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL =
  "Matrix encryption initialization did not finish within 45 seconds. Keep Codever visible, check the network, and retry.";

export const MATRIX_SYNC_CHECKPOINT_RECOVERY_DETAIL =
  "Rebuilding the Matrix sync checkpoint and refreshing trusted device keys…";

export const MATRIX_SYNC_CHECKPOINT_SAVE_DETAIL =
  "Saving the rebuilt Matrix sync checkpoint…";

export function shouldRecoverMatrixSyncCheckpoint(
  hasActiveTrust: boolean,
  savedSyncToken: string | null,
): boolean {
  return hasActiveTrust && !savedSyncToken;
}

export function matrixInitialSyncLimit(
  hasActiveTrust: boolean,
  recoveringSyncCheckpoint: boolean,
): number {
  return hasActiveTrust && !recoveringSyncCheckpoint ? 30 : 1;
}

export function shouldDeferStoredMatrixStartupForPairing(input: {
  pairingLink: string | null;
  deviceInvitation: string | null;
  shortInvitation: string | null;
}): boolean {
  return Boolean(
    input.pairingLink || input.deviceInvitation || input.shortInvitation,
  );
}

export function shouldReloadInterruptedMatrixStartup(input: {
  phase: string;
  startedAt: number;
  hiddenAt: number | null;
  now: number;
  visible: boolean;
}): boolean {
  if (
    !input.visible ||
    (input.phase !== "connecting" && input.phase !== "securing")
  ) {
    return false;
  }
  if (
    input.hiddenAt !== null &&
    input.now - input.hiddenAt >= MATRIX_STARTUP_BACKGROUND_RECOVERY_MS
  ) {
    return true;
  }
  return input.now - input.startedAt >= MATRIX_STARTUP_FOREGROUND_BUDGET_MS;
}
