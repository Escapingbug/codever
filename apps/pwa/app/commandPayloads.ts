import type { CommandPayload } from "@codever/protocol";

type PromptCommandPayload = Extract<
  CommandPayload,
  { operation: "prompt" }
>;

type CancelCommandPayload = Extract<
  CommandPayload,
  { operation: "cancel" }
>;

export function createPromptCommandPayload(
  input: Omit<PromptCommandPayload, "operation">,
): PromptCommandPayload {
  const { attachments, ...prompt } = input;
  return {
    operation: "prompt",
    ...prompt,
    ...(attachments === undefined ? {} : { attachments }),
  };
}

export function createCancelCommandPayload(
  sessionId: string,
  targetCommandId: string,
): CancelCommandPayload {
  return {
    operation: "cancel",
    sessionId,
    targetCommandId,
  };
}
