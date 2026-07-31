export const MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS = 2 * 60_000;

export const MATRIX_CRYPTO_LOADING_DETAIL =
  "Loading and initializing end-to-end encryption… The first load downloads several megabytes and may take up to two minutes on a mobile connection.";

export const MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL =
  "Matrix encryption initialization did not finish within two minutes. Check the network, close other Codever tabs, and scan a new invitation.";

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
