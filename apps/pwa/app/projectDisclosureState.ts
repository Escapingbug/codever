import { gatewayProjectKey } from "./gatewayState";

export const PROJECT_DISCLOSURE_STORAGE_KEY =
  "codever.ui.project-disclosure.v1";

const MAX_PERSISTED_PROJECTS = 1_000;

export type ProjectDisclosureState = ReadonlySet<string>;

export type StorageReader = Pick<Storage, "getItem">;
export type StorageWriter = Pick<Storage, "setItem">;

type PersistedProjectDisclosureState = {
  version: 1;
  collapsed: string[];
};

/**
 * Creates the stable disclosure identity shared by rendering and persistence.
 * The helper remains exported here so UI callers do not need to know where the
 * Gateway/project identity format is owned.
 */
export function projectDisclosureKey(
  gatewayId: string,
  projectId: string,
): string {
  return gatewayProjectKey(gatewayId, projectId);
}

export function setProjectCollapsed(
  state: ProjectDisclosureState,
  projectKey: string,
  collapsed: boolean,
): Set<string> {
  const next = new Set(state);
  if (collapsed) next.add(projectKey);
  else next.delete(projectKey);
  return next;
}

export function toggleProjectCollapsed(
  state: ProjectDisclosureState,
  projectKey: string,
): Set<string> {
  return setProjectCollapsed(state, projectKey, !state.has(projectKey));
}

/**
 * Search results temporarily win over a persisted collapse preference. A
 * newly selected conversation is expanded explicitly by the caller, so the
 * user can still collapse the currently open project afterward.
 */
export function isProjectExpanded(input: {
  state: ProjectDisclosureState;
  projectKey: string;
  searchQuery?: string;
}): boolean {
  if (input.searchQuery?.trim()) return true;
  return !input.state.has(input.projectKey);
}

export function readProjectDisclosureState(
  storage: StorageReader | null | undefined,
): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(PROJECT_DISCLOSURE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedProjectDisclosureState(parsed)) return new Set();
    return new Set(parsed.collapsed);
  } catch {
    // localStorage may be unavailable in private/locked-down browser contexts.
    return new Set();
  }
}

export function writeProjectDisclosureState(
  storage: StorageWriter | null | undefined,
  state: ProjectDisclosureState,
): boolean {
  if (!storage) return false;
  const collapsed = [...state]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort()
    .slice(0, MAX_PERSISTED_PROJECTS);
  const value: PersistedProjectDisclosureState = {
    version: 1,
    collapsed,
  };
  try {
    storage.setItem(PROJECT_DISCLOSURE_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    // Quota and security errors must not make the conversation list unusable.
    return false;
  }
}

function isPersistedProjectDisclosureState(
  value: unknown,
): value is PersistedProjectDisclosureState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.collapsed) &&
    candidate.collapsed.length <= MAX_PERSISTED_PROJECTS &&
    candidate.collapsed.every(
      (item) => typeof item === "string" && item.length > 0,
    )
  );
}
