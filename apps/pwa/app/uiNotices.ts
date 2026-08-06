export type UiNoticeScope =
  | "connection"
  | "pairing"
  | "history"
  | "session"
  | "composer"
  | "attachment"
  | "update";

export type UiNoticeSeverity = "info" | "success" | "warning" | "error";

export type UiNotice = {
  /** Stable identity such as `session:create` or `attachment:upload`. */
  key: string;
  scope: UiNoticeScope;
  severity: UiNoticeSeverity;
  message: string;
  createdAt: number;
  expiresAt: number | null;
};

export type UiNoticeState = Readonly<Record<string, UiNotice>>;

export type UiNoticeEvent =
  | {
      type: "show";
      key: string;
      scope: UiNoticeScope;
      severity: UiNoticeSeverity;
      message: string;
      now: number;
      autoDismissMs?: number | null;
    }
  | { type: "dismiss"; key: string }
  | { type: "scope-recovered"; scope: UiNoticeScope }
  | { type: "operation-recovered"; key: string }
  | { type: "tick"; now: number };

export const EMPTY_UI_NOTICE_STATE: UiNoticeState = Object.freeze({});

/**
 * Notice state is keyed by operation, so an attachment error cannot overwrite
 * a connection problem. Informational and success notices expire by default;
 * warnings/errors stay until dismissal or an explicit recovery event.
 */
export function reduceUiNotices(
  state: UiNoticeState,
  event: UiNoticeEvent,
): UiNoticeState {
  switch (event.type) {
    case "show": {
      const duration = event.autoDismissMs === undefined
        ? defaultAutoDismissMs(event.severity)
        : event.autoDismissMs;
      return {
        ...state,
        [event.key]: {
          key: event.key,
          scope: event.scope,
          severity: event.severity,
          message: event.message.trim(),
          createdAt: event.now,
          expiresAt: duration === null ? null : event.now + Math.max(0, duration),
        },
      };
    }
    case "dismiss":
    case "operation-recovered":
      return omitNotices(state, (notice) => notice.key === event.key);
    case "scope-recovered":
      return omitNotices(state, (notice) => notice.scope === event.scope);
    case "tick":
      return omitNotices(
        state,
        (notice) => notice.expiresAt !== null && notice.expiresAt <= event.now,
      );
  }
}

export function noticesForScope(
  state: UiNoticeState,
  scope: UiNoticeScope,
): UiNotice[] {
  return Object.values(state)
    .filter((notice) => notice.scope === scope)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function shouldShowGlobalNotice(notice: UiNotice): boolean {
  return (
    notice.severity === "error" &&
    (notice.scope === "connection" || notice.scope === "pairing")
  );
}

function defaultAutoDismissMs(severity: UiNoticeSeverity): number | null {
  if (severity === "success") return 4_000;
  if (severity === "info") return 6_000;
  return null;
}

function omitNotices(
  state: UiNoticeState,
  predicate: (notice: UiNotice) => boolean,
): UiNoticeState {
  const entries = Object.entries(state).filter(([, notice]) => !predicate(notice));
  return entries.length === Object.keys(state).length
    ? state
    : Object.fromEntries(entries);
}
