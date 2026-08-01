import type { CommandPayload } from "@codever/protocol";

type PromptCommandPayload = Extract<
  CommandPayload,
  { operation: "prompt" }
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
