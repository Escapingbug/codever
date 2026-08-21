import type { JsonObject } from "@codever/native-bridge";
import type {
  CommandPayload,
  CodeverAttachment,
  SessionExtensionBinding,
} from "@codever/protocol";
import type { CommandCompletion } from "../../commandLifecycle";
import {
  requestMatrixLoginToken,
  type MatrixLoginTokenResult,
} from "../../matrixAuth";
import {
  saveMatrixConfig,
  type IncomingCodeverMessage,
  type MatrixConnection,
  type MatrixConnectionConfig,
} from "../../matrix";
import { connectMatrixCvp3 } from "../../matrixCvp3Connection";
import {
  inspectPairingLink,
  saveTrustedGateway,
  trustedGatewayConfig,
  type PairingPreview as WebPairingPreview,
  type TrustedGateway,
} from "../../pairing";
import type {
  CodeverClient,
  CodeverClientHandlers,
  CodeverCommandSendResult,
  CodeverHistoryPage,
  CodeverMessage,
  CodeverPairingPreview,
  CodeverPublicTrust,
} from "../CodeverClient";

/** Web implementation backed by the existing matrix-js-sdk transport. */
export class WebCodeverClient implements CodeverClient {
  readonly runtime = "web" as const;
  #trustedGateway: TrustedGateway | null = null;

  constructor(
    private readonly transport: MatrixConnection,
    private readonly config: MatrixConnectionConfig,
  ) {}

  get ready(): Promise<void> {
    return this.transport.ready;
  }

  get deviceId(): string {
    return this.transport.identity.keyId;
  }

  get deviceName(): string {
    return (
      this.#trustedGateway?.certificate.certificate.deviceName ??
      "Codever Web device"
    );
  }

  updateTrustedGateway(trust: TrustedGateway): void {
    this.#trustedGateway = trust;
  }

  async pair(
    pairingLink: string,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<CodeverPublicTrust> {
    const preview = await inspectPairingLink(pairingLink);
    const trust = await this.transport.pair(preview, deviceName, signal);
    this.updateTrustedGateway(trust);
    saveTrustedGateway(trust);
    saveMatrixConfig({ ...this.config, ...trustedGatewayConfig(trust) });
    return publicTrustFromWeb(trust);
  }

  async send(payload: CommandPayload): Promise<CodeverCommandSendResult> {
    return commandResultFromWeb(await this.transport.send(payload));
  }

  async updateProjectExtensions(
    extensions: SessionExtensionBinding[],
  ): Promise<CodeverCommandSendResult> {
    if (!this.transport.updateProjectExtensions) {
      throw new Error("This connection cannot update project extension defaults.");
    }
    return commandResultFromWeb(
      await this.transport.updateProjectExtensions(extensions),
    );
  }

  requestMatrixLoginToken(
    _invitationId: string,
    password?: string,
  ): Promise<MatrixLoginTokenResult> {
    return requestMatrixLoginToken(this.config, password);
  }

  async recoverCommand(commandId: string): Promise<CodeverCommandSendResult> {
    return commandResultFromWeb(await this.transport.recoverCommand(commandId));
  }

  uploadAttachment(file: File): Promise<CodeverAttachment> {
    return this.transport.uploadAttachment(file);
  }

  downloadAttachment(attachment: CodeverAttachment): Promise<Blob> {
    return this.transport.downloadAttachment(attachment);
  }

  async confirmRevisionRetry(
    commandId: string,
  ): Promise<CodeverCommandSendResult> {
    return commandResultFromWeb(
      await this.transport.confirmRevisionRetry(commandId),
    );
  }

  discardRevisionConflict(commandId: string): Promise<void> {
    return this.transport.discardRevisionConflict(commandId);
  }

  markHistoryLoaded(sessionId: string, eventIds: readonly string[]): void {
    this.transport.markHistoryLoaded(sessionId, eventIds);
  }

  async loadLocalHistory(
    sessionId: string,
  ): Promise<CodeverHistoryPage> {
    const page = await this.transport.loadLocalHistory(sessionId);
    return {
      messages: page.messages.map(messageFromWeb),
      hasMore: page.hasMore,
    };
  }

  async loadHistoryPage(
    sessionId: string,
    limit?: number,
  ): Promise<CodeverHistoryPage> {
    const page = await this.transport.loadHistoryPage(sessionId, limit);
    return {
      messages: page.messages.map(messageFromWeb),
      hasMore: page.hasMore,
    };
  }

  observeCommandCompletion(
    commandId: string,
    timeoutMs: number,
  ): Promise<CommandCompletion> {
    return this.transport.observeCommandCompletion(commandId, timeoutMs);
  }

  releaseCommand(commandId: string): Promise<void> {
    return this.transport.releaseCommand(commandId);
  }

  async disconnect(): Promise<void> {
    this.transport.stop();
  }

  dispose(): void {
    // A web transport is scoped to this document. Native implementations must
    // only detach their WebView here and keep the foreground service running.
    this.transport.stop();
  }
}

export type CreateWebCodeverClientDependencies = {
  connect: typeof connectMatrixCvp3;
};

const defaultDependencies: CreateWebCodeverClientDependencies = {
  connect: connectMatrixCvp3,
};

export async function createWebCodeverClient(
  config: MatrixConnectionConfig,
  handlers: CodeverClientHandlers,
  dependencies: CreateWebCodeverClientDependencies = defaultDependencies,
): Promise<WebCodeverClient> {
  let client: WebCodeverClient | null = null;
  const transport = await dependencies.connect(config, {
    onMessage(message) {
      handlers.onMessage(messageFromWeb(message));
    },
    onStatus: handlers.onStatus,
    onTrustUpdated(trust) {
      client?.updateTrustedGateway(trust);
      saveTrustedGateway(trust);
      saveMatrixConfig({ ...config, ...trustedGatewayConfig(trust) });
      handlers.onTrustUpdated?.(publicTrustFromWeb(trust));
    },
    onCollaborationState: handlers.onCollaborationState,
    onCommandResult: handlers.onCommandResult,
    onHistoryRecovered(page) {
      handlers.onHistoryRecovered?.({
        sessionId: page.sessionId,
        messages: page.messages.map(messageFromWeb),
        hasMore: page.hasMore,
      });
    },
    onConvergenceRequired: handlers.onConvergenceRequired,
  });
  client = new WebCodeverClient(transport, config);
  return client;
}

export function publicTrustFromWeb(trust: TrustedGateway): CodeverPublicTrust {
  return {
    state: "trusted",
    gatewayId: trust.gatewayId,
    gatewayName: trust.gatewayName,
    certificateId: trust.certificate.certificate.certificateId,
    pairedAt: trust.pairedAt,
    ...(trust.activeDeviceCount === undefined
      ? {}
      : { activeDeviceCount: trust.activeDeviceCount }),
  };
}

export function publicPairingFromWeb(
  preview: WebPairingPreview,
): CodeverPairingPreview {
  return {
    pairingId: preview.signedOffer.offer.offerId,
    gatewayId: preview.gatewayId,
    gatewayName: preview.gatewayName,
    verificationCode: preview.verificationCode,
    expiresAt: preview.expiresAt,
    requiresNativeConfirmation: true,
  };
}

function commandResultFromWeb(
  result: Awaited<ReturnType<MatrixConnection["send"]>>,
): CodeverCommandSendResult {
  return {
    operationId: result.commandId,
    commandId: result.commandId,
    sequence: result.sequence,
    revision: result.revision,
    completion: result.completion,
  };
}

function messageFromWeb(message: IncomingCodeverMessage): CodeverMessage {
  return {
    eventId: message.eventId,
    sender: message.sender,
    timestamp: message.timestamp,
    encrypted: message.encrypted,
    kind: message.kind,
    text: message.text,
    sessionId: message.sessionId,
    historical: message.historical,
    operationId: message.operationId,
    requestId: message.requestId,
    replacesEventId: message.replacesEventId,
    commandId: message.commandId,
    revision: message.revision,
    originDeviceId: message.originDeviceId,
    originDeviceName: message.originDeviceName,
    activeDeviceCount: message.activeDeviceCount,
    format: message.format,
    attachments: message.attachments,
    toolGroup: message.toolGroup,
    semantic: jsonObject(message.raw),
  };
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The normalized Codever semantic payload is not JSON.");
  }
  return parsed as JsonObject;
}
