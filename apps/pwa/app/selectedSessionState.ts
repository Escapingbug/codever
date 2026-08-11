export const SELECTED_SESSION_STORAGE_PREFIX =
  "codever.ui.selected-session.v1";

type SelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function selectedSessionStorageKey(scope: string): string {
  if (!scope || scope.length > 4_096) {
    throw new Error("Selected-session scope is invalid.");
  }
  return `${SELECTED_SESSION_STORAGE_PREFIX}.${encodeURIComponent(scope)}`;
}

export function readSelectedSession(
  storage: Pick<Storage, "getItem"> | null | undefined,
  scope: string,
): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(selectedSessionStorageKey(scope));
    return value && value.length <= 512 ? value : null;
  } catch {
    return null;
  }
}

export function writeSelectedSession(
  storage: SelectionStorage | null | undefined,
  scope: string,
  sessionId: string | null,
): boolean {
  if (!storage) return false;
  try {
    const key = selectedSessionStorageKey(scope);
    if (sessionId === null) {
      storage.removeItem(key);
    } else {
      if (!sessionId || sessionId.length > 512) return false;
      storage.setItem(key, sessionId);
    }
    return true;
  } catch {
    return false;
  }
}
