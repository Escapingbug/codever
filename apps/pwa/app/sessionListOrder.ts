import type { GatewaySessionSummary } from "./gatewayState";
import {
  sessionIndicator,
  type SessionReadState,
} from "./sessionIndicators";

export type SessionListSignal = "failed" | "ready" | "working" | "idle";

export type ProjectSessionSummary = Readonly<{
  needsUser: number;
  working: number;
  total: number;
}>;

export function sessionListSignal(
  session: GatewaySessionSummary,
  readState: SessionReadState,
): SessionListSignal {
  const indicator = sessionIndicator(session, readState);
  if (indicator.activity === "failed") return "failed";
  if (indicator.activity === "idle" && indicator.unread) return "ready";
  if (
    indicator.activity === "running" ||
    indicator.activity === "stopping"
  ) {
    return "working";
  }
  return "idle";
}

export function compareSessionsForAction(
  left: GatewaySessionSummary,
  right: GatewaySessionSummary,
  readState: SessionReadState,
): number {
  const priority =
    signalPriority(sessionListSignal(right, readState)) -
    signalPriority(sessionListSignal(left, readState));
  if (priority !== 0) return priority;
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  return left.title.localeCompare(right.title);
}

export function compareProjectSessionsForAction(
  left: readonly GatewaySessionSummary[],
  right: readonly GatewaySessionSummary[],
  readState: SessionReadState,
): number {
  const leftLead = leadingSession(left, readState);
  const rightLead = leadingSession(right, readState);
  if (!leftLead) return rightLead ? 1 : 0;
  if (!rightLead) return -1;
  return compareSessionsForAction(leftLead, rightLead, readState);
}

export function summarizeProjectSessions(
  sessions: readonly GatewaySessionSummary[],
  readState: SessionReadState,
): ProjectSessionSummary {
  let needsUser = 0;
  let working = 0;
  for (const session of sessions) {
    const signal = sessionListSignal(session, readState);
    if (signal === "failed" || signal === "ready") needsUser += 1;
    if (signal === "working") working += 1;
  }
  return { needsUser, working, total: sessions.length };
}

export function projectSessionSummaryLabel(
  projectName: string,
  summary: ProjectSessionSummary,
): string {
  const parts = [projectName];
  if (summary.needsUser > 0) {
    parts.push(
      `${summary.needsUser} ${summary.needsUser === 1 ? "conversation needs" : "conversations need"} you`,
    );
  }
  if (summary.working > 0) {
    parts.push(
      `${summary.working} ${summary.working === 1 ? "conversation is" : "conversations are"} working`,
    );
  }
  parts.push(`${summary.total} ${summary.total === 1 ? "conversation" : "conversations"}`);
  return parts.join(", ");
}

export function sessionSignalLabel(signal: SessionListSignal): string | null {
  switch (signal) {
    case "failed":
      return "The agent stopped with an error";
    case "ready":
      return "New result ready to review";
    case "working":
      return "Agent is working";
    case "idle":
      return null;
  }
}

function leadingSession(
  sessions: readonly GatewaySessionSummary[],
  readState: SessionReadState,
): GatewaySessionSummary | null {
  let lead: GatewaySessionSummary | null = null;
  for (const session of sessions) {
    if (!lead || compareSessionsForAction(session, lead, readState) < 0) {
      lead = session;
    }
  }
  return lead;
}

function signalPriority(signal: SessionListSignal): number {
  switch (signal) {
    case "failed":
      return 4;
    case "ready":
      return 3;
    case "working":
      return 2;
    case "idle":
      return 1;
  }
}
