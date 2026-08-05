import type {
  ClientMessage,
  HelloResult,
  PairingPreview,
  PublicTrustState,
} from "@codever/native-bridge";
import type {
  CodeverAttachment,
  CommandPayload,
} from "@codever/protocol";
import type { CommandCompletion } from "../commandLifecycle";
import type { MatrixLoginTokenResult } from "../matrixAuth";
import type {
  CollaborationState,
  MatrixConnectionStatus,
} from "../matrix";

export type CodeverClientRuntime = "web" | "native";
export type CodeverNativeRuntimeInfo = HelloResult["native"];
export type CodeverMessage = ClientMessage;
export type CodeverPairingPreview = PairingPreview;
export type CodeverPublicTrust = Extract<
  PublicTrustState,
  { state: "trusted" }
>;

export type CodeverCommandSendResult = {
  operationId: string;
  commandId: string;
  sequence: number;
  revision: number;
  completion: Promise<CommandCompletion>;
};

export type CodeverHistoryPage = {
  messages: CodeverMessage[];
  hasMore: boolean;
};

export type CodeverHistoryRecovery = CodeverHistoryPage & {
  sessionId: string;
};

export type CodeverClientHandlers = {
  onMessage(message: CodeverMessage): void;
  onStatus(status: MatrixConnectionStatus, detail?: string): void;
  onNativeRuntime?(runtime: CodeverNativeRuntimeInfo | null): void;
  onTrustUpdated?(trust: CodeverPublicTrust | null): void;
  onCollaborationState?(state: CollaborationState): void;
  onCommandResult?(result: CommandCompletion): void;
  onHistoryRecovered?(page: CodeverHistoryRecovery): void;
};

/**
 * Native-safe UI boundary. No Matrix access token, CryptoKey, raw Matrix event,
 * signed trust certificate, or provider SDK object may cross this interface.
 *
 * `dispose()` follows the UI host lifecycle: a web client closes the transport
 * owned by the current tab, while a native client only detaches the WebView and
 * leaves its foreground service connected. `disconnect()` is the explicit user
 * action that stops the active transport on every runtime.
 */
export interface CodeverClient {
  readonly runtime: CodeverClientRuntime;
  readonly ready: Promise<void>;
  readonly deviceId: string;
  readonly deviceName: string;

  pair(
    pairingLink: string,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<CodeverPublicTrust>;
  requestMatrixLoginToken(
    invitationId: string,
    password?: string,
  ): Promise<MatrixLoginTokenResult>;
  send(payload: CommandPayload): Promise<CodeverCommandSendResult>;
  recoverCommand(commandId: string): Promise<CodeverCommandSendResult>;
  uploadAttachment(file: File): Promise<CodeverAttachment>;
  downloadAttachment(attachment: CodeverAttachment): Promise<Blob>;
  confirmRevisionRetry(commandId: string): Promise<CodeverCommandSendResult>;
  discardRevisionConflict(commandId: string): Promise<void>;
  markHistoryLoaded(sessionId: string, eventIds: readonly string[]): void;
  loadRecentHistory(
    sessionId: string,
    limit?: number,
  ): Promise<CodeverHistoryPage>;
  loadHistoryPage(
    sessionId: string,
    limit?: number,
  ): Promise<CodeverHistoryPage>;
  observeCommandCompletion(
    commandId: string,
    timeoutMs: number,
  ): Promise<CommandCompletion>;
  releaseCommand(commandId: string): Promise<void>;

  disconnect(): Promise<void>;
  dispose(): void;
}
