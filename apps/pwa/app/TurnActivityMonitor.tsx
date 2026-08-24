"use client";

import { useLayoutEffect, useRef } from "react";
import type {
  ToolCategory,
  ToolGroupPresentation,
  ToolPresentationItem,
} from "./presentation";

export function TurnActivityMonitor({
  group,
}: {
  group: ToolGroupPresentation;
}) {
  const trailRef = useRef<HTMLOListElement | null>(null);
  const currentRef = useRef<HTMLLIElement | null>(null);
  const followLatestRef = useRef(true);
  const current = currentTool(group.tools);
  const currentIsRunning = Boolean(
    current && (current.phase === "started" || current.phase === "updated"),
  );
  const failed = group.tools.filter(
    (tool) => tool.phase === "failed" || tool.isError,
  ).length;

  useLayoutEffect(() => {
    if (!followLatestRef.current) return;
    currentRef.current?.scrollIntoView({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  }, [current?.id, group.tools.length]);

  function updateFollowLatest() {
    const trail = trailRef.current;
    if (!trail) return;
    const horizontalRemaining =
      trail.scrollWidth - trail.clientWidth - trail.scrollLeft;
    const verticalRemaining =
      trail.scrollHeight - trail.clientHeight - trail.scrollTop;
    followLatestRef.current =
      trail.scrollWidth > trail.clientWidth + 1
        ? horizontalRemaining <= 18
        : verticalRemaining <= 18;
  }

  return (
    <aside
      className={`turn-activity-monitor ${failed ? "has-error" : ""}`}
      aria-label={`Live Agent activity, ${group.tools.length} tool ${group.tools.length === 1 ? "call" : "calls"}`}
    >
      <header aria-live="polite" aria-atomic="true">
        <span className="turn-activity-pulse" aria-hidden="true" />
        <span className="turn-activity-current">
          <small>{currentIsRunning ? "Running now" : "Latest tool"}</small>
          <strong>{current?.name || "Agent tool"}</strong>
          <code title={current?.detail || current?.title}>
            {current?.detail || current?.title || "Waiting for activity"}
          </code>
        </span>
        <span className="turn-activity-count">
          {group.tools.length}
          <small>calls</small>
        </span>
      </header>

      <ol
        className="turn-activity-trail"
        aria-label="Tool calls in this turn"
        onScroll={updateFollowLatest}
        ref={trailRef}
      >
        {group.tools.map((tool, index) => {
          const isCurrent = tool.id === current?.id;
          return (
            <li
              aria-current={isCurrent ? "step" : undefined}
              className={`${isCurrent ? "is-current" : ""} ${tool.isError || tool.phase === "failed" ? "has-error" : ""}`}
              key={tool.id}
              ref={isCurrent ? currentRef : undefined}
              title={`${tool.name}${tool.detail ? ` · ${tool.detail}` : ""}`}
            >
              <span
                className={`turn-activity-tool-icon category-${tool.category}`}
                aria-hidden="true"
              >
                {toolIcon(tool.category)}
              </span>
              <span className="turn-activity-tool-copy">
                <strong>
                  <i>{index + 1}</i>
                  {tool.name}
                </strong>
                <small>{tool.detail || tool.title}</small>
              </span>
              <ToolTrailState tool={tool} />
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function ToolTrailState({ tool }: { tool: ToolPresentationItem }) {
  const active = tool.phase === "started" || tool.phase === "updated";
  return (
    <span
      className={`turn-activity-tool-state ${active ? "is-running" : tool.phase === "failed" || tool.isError ? "is-failed" : "is-complete"}`}
      aria-label={active ? "Running" : tool.phase === "failed" || tool.isError ? "Failed" : "Completed"}
      title={active ? "Running" : tool.phase === "failed" || tool.isError ? "Failed" : "Completed"}
    >
      {active ? "" : tool.phase === "failed" || tool.isError ? "×" : "✓"}
    </span>
  );
}

function currentTool(
  tools: readonly ToolPresentationItem[],
): ToolPresentationItem | undefined {
  return (
    [...tools]
      .reverse()
      .find(
        (tool) => tool.phase === "started" || tool.phase === "updated",
      ) ?? tools.at(-1)
  );
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
