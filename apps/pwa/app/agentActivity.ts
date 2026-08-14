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

export type AgentExecutionSignal =
  | "running"
  | "stopping"
  | "stopped"
  | null;

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
 * Unknown events preserve the current activity. A visible message clears it
 * because the transcript itself becomes the progress indicator.
 */
export function reduceAgentActivity(
  current: AgentActivity | null,
  raw: unknown,
): AgentActivity | null {
  const event = asRecord(raw);
  if (!event) return current;

  if (event.kind === "status") {
    switch (event.activity_phase ?? event.state) {
      case "starting":
      case "querying":
        // A delayed querying notice must not make an already-visible tool or
        // running state appear to move backwards to "starting".
        return current?.phase === "working" || current?.phase === "stopping"
          ? current
          : STARTING_AGENT_ACTIVITY;
      case "running":
      case "working":
        return WORKING_AGENT_ACTIVITY;
      case "stopping":
      case "canceling":
        return STOPPING_AGENT_ACTIVITY;
      case "idle":
      case "failed":
        return null;
      default:
        return current;
    }
  }

  if (event.kind === "message") return null;
  if (event.kind === "decision_request") {
    return createActivity(
      "working",
      "Waiting for permission…",
      optionalNonemptyString(event.title),
    );
  }
  return current;
}

/**
 * Derives whether the full Agent turn is still interruptible.
 *
 * Individual text or tool completions are not terminal because a turn may
 * continue with more text, tools, or permission requests afterwards. Only an
 * explicit session lifecycle transition or fatal Agent error ends the turn.
 */
export function agentExecutionSignal(raw: unknown): AgentExecutionSignal {
  const event = asRecord(raw);
  if (!event) return null;
  const statusPhase =
    event.kind === "status" ? event.activity_phase ?? event.state : undefined;
  if (
    event.kind === "status" &&
      (statusPhase === "starting" ||
        statusPhase === "querying" ||
        statusPhase === "running" ||
        statusPhase === "working")
  ) {
    return "running";
  }
  if (
    event.kind === "status" &&
      (statusPhase === "canceling" || statusPhase === "stopping")
  ) {
    return "stopping";
  }
  if (
    event.kind === "status" &&
      (statusPhase === "idle" || statusPhase === "failed")
  ) {
    return "stopped";
  }
  return null;
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
