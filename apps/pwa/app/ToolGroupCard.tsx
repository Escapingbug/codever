"use client";

import { useMemo, useState } from "react";
import type {
  ToolCategory,
  ToolGroupPresentation,
  ToolPhase,
  ToolPresentationItem,
} from "./presentation";

export function ToolGroupCard({
  group,
  time,
}: {
  group: ToolGroupPresentation;
  time?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useMemo(
    () => `tool-group-${safeDomId(group.groupId)}`,
    [group.groupId],
  );
  const summary = toolGroupSummary(group.tools);
  const latest = group.tools.at(-1);

  return (
    <article
      className={`tool-group-card ${summary.failed > 0 ? "has-error" : ""}`}
    >
      <button
        type="button"
        className="tool-group-summary"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span
          className={`tool-group-icon category-${latest?.category ?? "unknown"}`}
          aria-hidden="true"
        >
          {toolIcon(latest?.category ?? "unknown")}
        </span>
        <span className="tool-group-copy">
          <strong>
            {group.tools.length === 1
              ? latest?.name || "Agent tool"
              : `${group.tools.length} tool calls`}
          </strong>
          <small>
            {group.tools.length === 1
              ? latest?.detail || latest?.title || "Tool activity"
              : toolGroupDescription(summary, latest)}
          </small>
        </span>
        <ToolState phase={summary.phase} label={summary.label} />
        <span className="tool-group-chevron" aria-hidden="true">
          {expanded ? "⌃" : "⌄"}
        </span>
      </button>

      {expanded && (
        <div
          className="tool-group-details"
          id={detailsId}
          role="region"
          aria-label="Tool call details"
        >
          <ol>
            {group.tools.map((tool) => (
              <li key={tool.id} className={tool.isError ? "has-error" : ""}>
                <span
                  className={`tool-item-icon category-${tool.category}`}
                  aria-hidden="true"
                >
                  {toolIcon(tool.category)}
                </span>
                <span className="tool-item-copy">
                  <strong>{tool.name}</strong>
                  {(tool.detail || tool.title !== tool.name) && (
                    <code>{tool.detail || tool.title}</code>
                  )}
                  {tool.result && <small>{tool.result}</small>}
                </span>
                <ToolState
                  phase={tool.phase}
                  label={toolPhaseLabel(tool.phase)}
                  compact
                />
              </li>
            ))}
          </ol>
          {time && <time>{time}</time>}
        </div>
      )}
    </article>
  );
}

function ToolState({
  phase,
  label,
  compact = false,
}: {
  phase: ToolPhase;
  label: string;
  compact?: boolean;
}) {
  return (
    <span
      className={`tool-state phase-${phase} ${compact ? "compact" : ""}`}
      role="status"
      aria-label={label}
      title={label}
    >
      <i aria-hidden="true">
        {phase === "completed"
          ? "✓"
          : phase === "failed"
            ? "×"
            : ""}
      </i>
      {!compact && <span>{label}</span>}
    </span>
  );
}

function toolGroupSummary(tools: readonly ToolPresentationItem[]): {
  completed: number;
  failed: number;
  running: number;
  phase: ToolPhase;
  label: string;
} {
  const failed = tools.filter(
    (tool) => tool.phase === "failed" || tool.isError,
  ).length;
  const running = tools.filter(
    (tool) => tool.phase === "started" || tool.phase === "updated",
  ).length;
  const completed = tools.length - failed - running;
  if (running > 0) {
    return {
      completed,
      failed,
      running,
      phase: "updated",
      label: "Running",
    };
  }
  if (failed > 0) {
    return {
      completed,
      failed,
      running,
      phase: "failed",
      label: failed === 1 ? "1 failed" : `${failed} failed`,
    };
  }
  return {
    completed,
    failed,
    running,
    phase: "completed",
    label: "Completed",
  };
}

function toolGroupDescription(
  summary: ReturnType<typeof toolGroupSummary>,
  latest: ToolPresentationItem | undefined,
): string {
  const counts = [
    summary.completed ? `${summary.completed} completed` : "",
    summary.running ? `${summary.running} running` : "",
    summary.failed ? `${summary.failed} failed` : "",
  ].filter(Boolean);
  const latestLabel = latest?.detail || latest?.title;
  return latestLabel
    ? `${counts.join(" · ")} · Latest: ${latestLabel}`
    : counts.join(" · ");
}

function toolPhaseLabel(phase: ToolPhase): string {
  switch (phase) {
    case "started":
    case "updated":
      return "Running";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
  }
}

function toolIcon(category: ToolCategory): string {
  switch (category) {
    case "execute":
      return ">_";
    case "edit":
      return "±";
    case "write":
      return "+";
    case "read":
      return "◫";
    case "search":
      return "⌕";
    case "agent":
      return "◇";
    case "unknown":
      return "•";
  }
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
