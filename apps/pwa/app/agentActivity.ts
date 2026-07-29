export type AgentActivityPhase =
  | "sending"
  | "starting"
  | "working"
  | "stopping";

export type AgentActivity = Readonly<{
  phase: AgentActivityPhase;
  label: string;
  detail?: string;
}>;

const ACTIVITY_LABELS: Readonly<Record<AgentActivityPhase, string>> = {
  sending: "Sending…",
  starting: "Starting agent…",
  working: "Agent is working…",
  stopping: "Stopping agent…",
};

export const SENDING_AGENT_ACTIVITY = agentActivityForPhase("sending");
export const STARTING_AGENT_ACTIVITY = agentActivityForPhase("starting");
export const WORKING_AGENT_ACTIVITY = agentActivityForPhase("working");
export const STOPPING_AGENT_ACTIVITY = agentActivityForPhase("stopping");

export function shouldApplyAgentActivity(
  currentSessionId: string | null,
  event: {
    sessionId?: string;
    historical?: boolean;
  },
): boolean {
  return (
    !event.historical &&
    Boolean(currentSessionId) &&
    event.sessionId === currentSessionId
  );
}

/**
 * Builds activity for local UI transitions such as optimistic sending or
 * stopping. Remote Agent lifecycle should be derived with
 * `reduceAgentActivity` so activity is shared across every connected device.
 */
export function agentActivityForPhase(
  phase: AgentActivityPhase,
  detail?: string,
): AgentActivity {
  return createActivity(phase, ACTIVITY_LABELS[phase], detail);
}

/**
 * Reduces an authenticated `IncomingCodeverMessage.raw` value into the
 * transient Agent activity shown by the conversation UI.
 *
 * Unknown events preserve the current activity. Terminal events clear it.
 * Text deltas also clear it because the visible streaming reply takes over as
 * the progress indicator.
 */
export function reduceAgentActivity(
  current: AgentActivity | null,
  raw: unknown,
): AgentActivity | null {
  const event = asRecord(raw);
  if (!event) return current;

  if (event.kind === "status") {
    switch (event.state) {
      case "querying":
        // A delayed querying notice must not make an already-visible tool or
        // running state appear to move backwards to "starting".
        return current?.phase === "working" || current?.phase === "stopping"
          ? current
          : STARTING_AGENT_ACTIVITY;
      case "running":
        return WORKING_AGENT_ACTIVITY;
      case "stopping":
        return STOPPING_AGENT_ACTIVITY;
      case "idle":
      case "failed":
        return null;
      default:
        return current;
    }
  }

  if (event.kind === "message") return null;

  switch (event.type) {
    case "session.updated":
      switch (event.status) {
        case "running":
          return WORKING_AGENT_ACTIVITY;
        case "stopping":
          return STOPPING_AGENT_ACTIVITY;
        case "idle":
        case "failed":
          return null;
        default:
          return current;
      }
    case "agent.tool.started":
      return createActivity(
        "working",
        "Using a tool…",
        optionalNonemptyString(event.name),
      );
    case "agent.permission.requested":
      return createActivity(
        "working",
        "Waiting for permission…",
        optionalNonemptyString(event.title),
      );
    case "agent.text.delta":
    case "agent.text.completed":
    case "agent.tool.completed":
    case "agent.error":
      return null;
    default:
      return current;
  }
}

function createActivity(
  phase: AgentActivityPhase,
  label: string,
  detail?: string,
): AgentActivity {
  const normalizedDetail = optionalNonemptyString(detail);
  return Object.freeze({
    phase,
    label,
    ...(normalizedDetail ? { detail: normalizedDetail } : {}),
  });
}

function optionalNonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
