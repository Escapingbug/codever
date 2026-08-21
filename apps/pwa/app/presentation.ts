import {
  sessionExtensionActionIdSchema,
  sessionExtensionViewSchema,
  type SessionExtensionSummary,
  type SessionExtensionView,
} from "@codever/protocol";

export type MessageFormat = "markdown" | "html" | "plain";

export type ToolCategory =
  | "read"
  | "edit"
  | "write"
  | "execute"
  | "search"
  | "agent"
  | "unknown";

export type ToolPhase = "started" | "updated" | "completed" | "failed";

export type ToolPresentationItem = {
  id: string;
  name: string;
  title: string;
  detail?: string;
  result?: string;
  category: ToolCategory;
  phase: ToolPhase;
  isError: boolean;
  startedAt: number;
  updatedAt: number;
};

export type ToolGroupPresentation = {
  kind: "tool_group";
  version: 1;
  groupId: string;
  tools: ToolPresentationItem[];
};

export type ExtensionViewPresentation = {
  extension: SessionExtensionSummary;
  view: SessionExtensionView;
  cancelActionId: string;
};

const TOOL_LIMIT = 200;
const TEXT_LIMIT = 512;

export function messageFormat(value: unknown): MessageFormat {
  return value === "markdown" || value === "html" || value === "plain"
    ? value
    : "plain";
}

export function parseToolGroupPresentation(
  value: unknown,
): ToolGroupPresentation | undefined {
  const record = asRecord(value);
  if (
    !record ||
    record.kind !== "tool_group" ||
    record.version !== 1 ||
    typeof record.groupId !== "string" ||
    !record.groupId.trim() ||
    !Array.isArray(record.tools)
  ) {
    return undefined;
  }

  const tools = record.tools
    .slice(0, TOOL_LIMIT)
    .flatMap((tool) => {
      const parsed = parseToolPresentationItem(tool);
      return parsed ? [parsed] : [];
    });
  if (tools.length === 0) return undefined;

  return {
    kind: "tool_group",
    version: 1,
    groupId: boundedText(record.groupId),
    tools,
  };
}

export function parseExtensionViewPresentation(
  value: unknown,
): ExtensionViewPresentation | undefined {
  const record = asRecord(value);
  const extension = asRecord(record?.extension);
  const parsedView = sessionExtensionViewSchema.safeParse(record?.view);
  const cancelActionId = record?.type === "extension.interaction.requested"
    ? record.cancelActionId
    : record?.cancel_action_id;
  if (
    (record?.kind !== "extension_view" && record?.type !== "extension.interaction.requested") ||
    !extension ||
    typeof extension.id !== "string" ||
    !extension.id.trim() ||
    typeof extension.name !== "string" ||
    !extension.name.trim() ||
    typeof extension.version !== "string" ||
    !extension.version.trim() ||
    !parsedView.success ||
    !sessionExtensionActionIdSchema.safeParse(cancelActionId).success ||
    !parsedView.data.actions.some(action => action.id === cancelActionId)
  ) {
    return undefined;
  }
  return {
    extension: {
      id: boundedText(extension.id),
      name: boundedText(extension.name),
      version: boundedText(extension.version),
    },
    view: parsedView.data,
    cancelActionId: cancelActionId as string,
  };
}

function parseToolPresentationItem(
  value: unknown,
): ToolPresentationItem | undefined {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    !record.id.trim() ||
    typeof record.name !== "string" ||
    !record.name.trim() ||
    typeof record.title !== "string" ||
    !record.title.trim() ||
    !isToolCategory(record.category) ||
    !isToolPhase(record.phase) ||
    typeof record.isError !== "boolean" ||
    !isFiniteNumber(record.startedAt) ||
    !isFiniteNumber(record.updatedAt)
  ) {
    return undefined;
  }

  return {
    id: boundedText(record.id),
    name: boundedText(record.name),
    title: boundedText(record.title),
    ...(typeof record.detail === "string" && record.detail.trim()
      ? { detail: boundedText(record.detail) }
      : {}),
    ...(typeof record.result === "string" && record.result.trim()
      ? { result: boundedText(record.result) }
      : {}),
    category: record.category,
    phase: record.phase,
    isError: record.isError,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  };
}

function isToolCategory(value: unknown): value is ToolCategory {
  return (
    value === "read" ||
    value === "edit" ||
    value === "write" ||
    value === "execute" ||
    value === "search" ||
    value === "agent" ||
    value === "unknown"
  );
}

function isToolPhase(value: unknown): value is ToolPhase {
  return (
    value === "started" ||
    value === "updated" ||
    value === "completed" ||
    value === "failed"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function boundedText(value: string): string {
  const normalized = value.trim();
  return normalized.length > TEXT_LIMIT
    ? `${normalized.slice(0, TEXT_LIMIT - 1)}…`
    : normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
