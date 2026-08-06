import type { GatewaySessionSummary } from "./gatewayState";

export const SESSION_READ_STATE_STORAGE_KEY = "codever.ui.session-read.v1";

const MAX_PERSISTED_SESSIONS = 5_000;

export type SessionReadState = {
  /**
   * False means this client has never established a baseline. Existing
   * sessions are marked read during bootstrap instead of all appearing new.
   */
  initialized: boolean;
  readUpdatedAt: Readonly<Record<string, number>>;
};

export type SessionIndicator = {
  activity: "running" | "stopping" | "failed" | "idle" | "archived";
  unread: boolean;
  needsAttention: boolean;
};

export type SessionIndicatorCounts = {
  total: number;
  running: number;
  stopping: number;
  failed: number;
  unread: number;
  needsAttention: number;
};

type PersistedSessionReadState = {
  version: 1;
  initialized: true;
  read_updated_at: Record<string, number>;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export const EMPTY_SESSION_READ_STATE: SessionReadState = Object.freeze({
  initialized: false,
  readUpdatedAt: Object.freeze({}),
});

/**
 * Establishes a first-run baseline. This deliberately does not infer that an
 * idle session "completed": Gateway status has no such transition history.
 */
export function initializeSessionReadState(
  state: SessionReadState,
  sessions: readonly GatewaySessionSummary[],
): SessionReadState {
  if (state.initialized) return state;
  return {
    initialized: true,
    readUpdatedAt: Object.fromEntries(
      sessions.map((session) => [session.id, session.updatedAt]),
    ),
  };
}

export function markSessionRead(
  state: SessionReadState,
  session: Pick<GatewaySessionSummary, "id" | "updatedAt">,
): SessionReadState {
  const previous = state.readUpdatedAt[session.id];
  if (state.initialized && previous !== undefined && previous >= session.updatedAt) {
    return state;
  }
  return {
    initialized: true,
    readUpdatedAt: {
      ...state.readUpdatedAt,
      [session.id]: Math.max(previous ?? 0, session.updatedAt),
    },
  };
}

/** Marks the selected conversation read whenever a fresher snapshot arrives. */
export function reconcileSelectedSessionReadState(
  state: SessionReadState,
  sessions: readonly GatewaySessionSummary[],
  selectedSessionId: string | null | undefined,
): SessionReadState {
  if (!selectedSessionId) return state;
  const selected = sessions.find((session) => session.id === selectedSessionId);
  return selected ? markSessionRead(state, selected) : state;
}

export function sessionIndicator(
  session: GatewaySessionSummary,
  state: SessionReadState,
): SessionIndicator {
  const activity = session.status;
  const lastRead = state.readUpdatedAt[session.id];
  const unread =
    state.initialized &&
    activity !== "archived" &&
    (lastRead === undefined || session.updatedAt > lastRead);
  return {
    activity,
    unread,
    needsAttention: activity === "failed" && unread,
  };
}

export function countSessionIndicators(
  sessions: readonly GatewaySessionSummary[],
  state: SessionReadState,
): SessionIndicatorCounts {
  const counts: SessionIndicatorCounts = {
    total: sessions.length,
    running: 0,
    stopping: 0,
    failed: 0,
    unread: 0,
    needsAttention: 0,
  };
  for (const session of sessions) {
    const indicator = sessionIndicator(session, state);
    if (indicator.activity === "running") counts.running += 1;
    if (indicator.activity === "stopping") counts.stopping += 1;
    if (indicator.activity === "failed") counts.failed += 1;
    if (indicator.unread) counts.unread += 1;
    if (indicator.needsAttention) counts.needsAttention += 1;
  }
  return counts;
}

/** Removes markers for sessions no longer present, keeping persistence bounded. */
export function pruneSessionReadState(
  state: SessionReadState,
  sessionIds: ReadonlySet<string>,
): SessionReadState {
  const entries = Object.entries(state.readUpdatedAt).filter(([sessionId]) =>
    sessionIds.has(sessionId),
  );
  if (entries.length === Object.keys(state.readUpdatedAt).length) return state;
  return {
    initialized: state.initialized,
    readUpdatedAt: Object.fromEntries(entries),
  };
}

export function readSessionReadState(
  storage: StorageReader | null | undefined,
): SessionReadState {
  if (!storage) return EMPTY_SESSION_READ_STATE;
  try {
    const raw = storage.getItem(SESSION_READ_STATE_STORAGE_KEY);
    if (!raw) return EMPTY_SESSION_READ_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedSessionReadState(parsed)) return EMPTY_SESSION_READ_STATE;
    return {
      initialized: true,
      readUpdatedAt: parsed.read_updated_at,
    };
  } catch {
    return EMPTY_SESSION_READ_STATE;
  }
}

export function writeSessionReadState(
  storage: StorageWriter | null | undefined,
  state: SessionReadState,
): boolean {
  if (!storage || !state.initialized) return false;
  const entries = Object.entries(state.readUpdatedAt)
    .filter(([, updatedAt]) => isTimestamp(updatedAt))
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_PERSISTED_SESSIONS);
  const value: PersistedSessionReadState = {
    version: 1,
    initialized: true,
    read_updated_at: Object.fromEntries(entries),
  };
  try {
    storage.setItem(SESSION_READ_STATE_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isPersistedSessionReadState(
  value: unknown,
): value is PersistedSessionReadState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const markers = candidate.read_updated_at;
  return (
    candidate.version === 1 &&
    candidate.initialized === true &&
    Boolean(markers) &&
    typeof markers === "object" &&
    !Array.isArray(markers) &&
    Object.keys(markers as object).length <= MAX_PERSISTED_SESSIONS &&
    Object.entries(markers as Record<string, unknown>).every(
      ([sessionId, updatedAt]) => sessionId.length > 0 && isTimestamp(updatedAt),
    )
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isFinite(value) && typeof value === "number" && value >= 0;
}
