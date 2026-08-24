import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnActivityMonitor } from "./TurnActivityMonitor";

describe("TurnActivityMonitor", () => {
  it("shows the current tool and a compact history trail together", () => {
    const html = renderToStaticMarkup(
      createElement(TurnActivityMonitor, {
        group: {
          kind: "tool_group",
          version: 1,
          groupId: "turn-1",
          tools: [
            tool("read", "Read", "completed"),
            tool("bash", "Bash", "updated"),
          ],
        },
      }),
    );

    expect(html).toContain("Live Agent activity, 2 tool calls");
    expect(html).toContain("Running now");
    expect(html).toContain("<strong>Bash</strong>");
    expect(html).toContain('aria-label="Tool calls in this turn"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("src/read.ts");
    expect(html).toContain("pnpm test");
  });
});

function tool(
  id: string,
  name: string,
  phase: "updated" | "completed",
) {
  return {
    id,
    name,
    title: name,
    detail: name === "Bash" ? "pnpm test" : "src/read.ts",
    category: name === "Bash" ? ("execute" as const) : ("read" as const),
    phase,
    isError: false,
    startedAt: 1,
    updatedAt: 2,
  };
}
