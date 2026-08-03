export type ComposerConnectionStatus =
  | "connecting"
  | "securing"
  | "connected"
  | "reconnecting"
  | "offline"
  | "error";

export interface ComposerStateInput {
  connectionStatus: ComposerConnectionStatus;
  hasGatewayState: boolean;
  hasSelectedSession: boolean;
  selectedArchived: boolean;
  attachmentBusy: boolean;
  promptSubmitting: boolean;
  isStreaming: boolean;
  isStopping: boolean;
  hasContent: boolean;
}

export interface ComposerState {
  canType: boolean;
  canSend: boolean;
  mode: "ready" | "queue" | "blocked";
  reason: string;
}

export function deriveComposerState(input: ComposerStateInput): ComposerState {
  const hasUsableSession =
    input.hasGatewayState &&
    input.hasSelectedSession &&
    !input.selectedArchived;
  const canType = hasUsableSession && !input.attachmentBusy;
  const blocked = (reason: string): ComposerState => ({
    canType,
    canSend: false,
    mode: "blocked",
    reason,
  });

  if (input.selectedArchived) {
    return blocked("Restore this session to continue.");
  }
  if (input.connectionStatus === "offline" || input.connectionStatus === "error") {
    return blocked("The Gateway is offline. Reconnect before sending.");
  }
  if (input.connectionStatus === "connecting") {
    return blocked("Connecting to Matrix… Your draft will be kept.");
  }
  if (input.connectionStatus === "securing") {
    return blocked("Matrix connected · verifying the trusted Gateway…");
  }
  if (input.connectionStatus === "reconnecting") {
    return blocked("Reconnecting to Matrix… Your draft will be kept.");
  }
  if (!input.hasGatewayState) {
    return blocked("Waiting for the current Gateway session state…");
  }
  if (!input.hasSelectedSession) {
    return blocked("Create or select a session before sending.");
  }
  if (input.attachmentBusy) {
    return blocked("Encrypting and uploading attachments…");
  }
  if (input.isStopping) {
    return blocked("Waiting for the agent to stop…");
  }
  if (input.promptSubmitting) {
    return blocked("Securing the previous message…");
  }
  if (!input.hasContent) {
    return blocked("Write a message or attach a file.");
  }
  if (input.isStreaming) {
    return {
      canType,
      canSend: true,
      mode: "queue",
      reason: "Agent is working · Send queues this message",
    };
  }
  return {
    canType,
    canSend: true,
    mode: "ready",
    reason: "Signed locally · Matrix E2EE transport · Enter to send",
  };
}
