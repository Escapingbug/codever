"use client";

import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CommandPayload } from "@codever/protocol";
import { MatrixSettings } from "./MatrixSettings";
import {
  NewSessionDialog,
  type NewSessionInput,
} from "./NewSessionDialog";
import { gatewayProjectKey } from "./gatewayState";
import {
  CommandRevisionConflictError,
  clearMatrixConfig,
  connectMatrix,
  getOrCreateDeviceIdentity,
  loadMatrixConfig,
  normalizeMatrixConfig,
  resolveMatrixSession,
  saveMatrixConfig,
  type IncomingCodeverMessage,
  type CommandSendResult,
  type GatewayStateSnapshot,
  type MatrixConnection,
  type MatrixConnectionConfig,
  type MatrixConnectionStatus,
} from "./matrix";
import {
  clearPendingPairing,
  clearTrustedGateway,
  inspectPairingLink,
  loadPendingPairingRecovery,
  loadTrustedGateway,
  saveTrustedGateway,
  trustedGatewayConfig,
  type PairingPreview,
  type TrustedGateway,
} from "./pairing";

type ChatMessage = {
  id: string;
  kind: "notice" | "user" | "agent" | "tool" | "permission" | "error";
  text?: string;
  time?: string;
  eventId?: string;
  requestId?: string;
  streamId?: string;
  commandId?: string;
  revision?: number;
  originDeviceId?: string;
  originDeviceName?: string;
  raw?: Record<string, unknown>;
};

type RevisionConflictNotice = {
  commandId: string;
  expectedRevision: number;
  payload: CommandPayload;
  optimisticMessageId?: string;
  busy: boolean;
};

const emptyMatrixConfig: MatrixConnectionConfig = {
  homeserver: "",
  userId: "",
  accessToken: "",
  matrixDeviceId: "",
  roomId: "",
  gatewayId: "",
  conversationId: "",
  gatewayMatrixUserId: "",
  gatewayMatrixDeviceId: "",
  gatewayMatrixEd25519: "",
};

function bindCredentialsToHomeserver(
  config: MatrixConnectionConfig,
  homeserver: string,
): MatrixConnectionConfig {
  let sameOrigin = false;
  try {
    sameOrigin =
      Boolean(config.homeserver) &&
      new URL(config.homeserver).origin === new URL(homeserver).origin;
  } catch {
    sameOrigin = false;
  }
  return {
    ...config,
    homeserver,
    userId: sameOrigin ? config.userId : "",
    accessToken: sameOrigin ? config.accessToken : "",
    matrixDeviceId: sameOrigin ? config.matrixDeviceId : "",
  };
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <span className="icon" aria-hidden="true">
      {children}
    </span>
  );
}

export function CodeverApp() {
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [matrixConfig, setMatrixConfig] = useState<MatrixConnectionConfig>(
    () => loadMatrixConfig() ?? emptyMatrixConfig,
  );
  const [connectionStatus, setConnectionStatus] =
    useState<MatrixConnectionStatus>("offline");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [deviceKeyId, setDeviceKeyId] = useState<string | null>(null);
  const [activeDeviceCount, setActiveDeviceCount] = useState<number | null>(
    null,
  );
  const [gatewayState, setGatewayState] =
    useState<GatewayStateSnapshot | null>(null);
  const [gatewayRevision, setGatewayRevision] = useState<number | null>(null);
  const [revisionConflict, setRevisionConflict] =
    useState<RevisionConflictNotice | null>(null);
  const [pairingPreview, setPairingPreview] =
    useState<PairingPreview | null>(null);
  const [trustedGateway, setTrustedGateway] =
    useState<TrustedGateway | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  const [decisionStates, setDecisionStates] = useState<
    Record<string, "pending" | "approved" | "denied">
  >({});
  const feedRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const matrixConnectionRef = useRef<MatrixConnection | null>(null);
  const pairingAbortRef = useRef<AbortController | null>(null);
  const pairingRecoveryRef = useRef<
    (
      preview: PairingPreview,
      config: MatrixConnectionConfig,
    ) => Promise<void>
  >(async () => {});
  const revisionConflictRef = useRef<RevisionConflictNotice | null>(null);
  const activePromptCommandIdRef = useRef<string | null>(null);
  const completedCommandResultsRef = useRef(new Set<string>());
  const currentSessionIdRef = useRef<string | null>(null);

  const selected =
    gatewayState?.sessions.find(
      (session) => session.id === gatewayState.currentSessionId,
    ) ?? null;
  const filteredSessions = useMemo(
    () =>
      (gatewayState?.sessions ?? []).filter((session) =>
        `${session.title} ${session.projectName} ${session.cwd} ${session.provider} ${session.model ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [gatewayState, search],
  );
  const projectGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        projectId: string;
        projectName: string;
        cwd: string;
        sessions: NonNullable<typeof gatewayState>["sessions"];
      }
    >();
    for (const session of filteredSessions) {
      const key = gatewayProjectKey(matrixConfig.gatewayId, session.projectId);
      const group = groups.get(key) ?? {
        key,
        projectId: session.projectId,
        projectName: session.projectName,
        cwd: session.cwd,
        sessions: [],
      };
      group.sessions.push(session);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [filteredSessions, gatewayState, matrixConfig.gatewayId]);
  const matrixConnected =
    connectionStatus === "connected" || connectionStatus === "reconnecting";
  const sessionReady = Boolean(matrixConnected && gatewayState && selected);
  const conversationTitle =
    selected?.title ??
    (trustedGateway
      ? gatewayState
        ? "No active session"
        : "Syncing Gateway state…"
      : "Add a Gateway");
  const activeProvider =
    gatewayState?.workspace.provider ?? selected?.provider ?? "Gateway agent";
  const activeModelCapability = gatewayState?.capabilities.models.find(
    (model) => model.id === gatewayState.workspace.model,
  );

  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js").catch(() => {
      // Offline support is opportunistic in local preview environments.
    });
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const link = hash.get("pair");
    const rejectedQueryPairing = url.searchParams.has("pair");
    if (link || rejectedQueryPairing) {
      hash.delete("pair");
      url.searchParams.delete("pair");
      const nextHash = hash.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`,
      );
    }
    if (link) void openPairingLink(link);
    void (async () => {
      if (rejectedQueryPairing) {
        await Promise.resolve();
        setConnectionError(
          "Pairing links in the URL query are not accepted. Scan the QR code or use a #pair link.",
        );
        setSettingsOpen(true);
        return;
      }
      const identity = await getOrCreateDeviceIdentity();
      const trust = await loadTrustedGateway(identity);
      if (trust) {
        clearPendingPairing();
        setTrustedGateway(trust);
        setActiveDeviceCount(trust.activeDeviceCount ?? null);
        setDeviceKeyId(identity.keyId);
        const stored = loadMatrixConfig() ?? emptyMatrixConfig;
        const trustedConfig: MatrixConnectionConfig = {
          ...bindCredentialsToHomeserver(
            stored,
            trust.gatewayTransport.homeserver,
          ),
          ...trustedGatewayConfig(trust),
          conversationId:
            stored.conversationId || trust.gatewayTransport.roomId,
        };
        setMatrixConfig(trustedConfig);
        setSettingsOpen(true);
        return;
      }
      if (link) return;
      const pending = await loadPendingPairingRecovery(identity);
      if (!pending) {
        setSettingsOpen(true);
        return;
      }
      if (pending.status === "expired") {
        setConnectionError(
          "The previous pairing request expired. Scan a new Gateway QR code.",
        );
        setSettingsOpen(true);
        return;
      }
      const preview = pending.preview;
      const transport = preview.transport;
      const stored = loadMatrixConfig() ?? emptyMatrixConfig;
      const recoveryConfig: MatrixConnectionConfig = {
        ...bindCredentialsToHomeserver(stored, transport.homeserver),
        roomId: transport.roomId,
        gatewayId: preview.gatewayId,
        conversationId: transport.roomId,
        gatewayMatrixUserId: transport.userId,
        gatewayMatrixDeviceId: transport.deviceId,
        gatewayMatrixEd25519: transport.ed25519,
      };
      setPairingPreview(preview);
      setMatrixConfig(recoveryConfig);
      setSettingsOpen(true);
      await pairingRecoveryRef.current(preview, recoveryConfig);
    })().catch((error) => {
      setConnectionError(`Saved trust could not be verified: ${formatUiError(error)}`);
    });
  }, []);

  useEffect(() => {
    if (!followLatestRef.current) return;
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "auto",
    });
  }, [messages, isStreaming]);

  useEffect(() => {
    followLatestRef.current = true;
  }, [selected?.id]);

  useEffect(
    () => () => {
      pairingAbortRef.current?.abort();
      matrixConnectionRef.current?.stop();
    },
    [],
  );

  function receiveMatrixMessage(incoming: IncomingCodeverMessage) {
    if (incoming.revision !== undefined) {
      setGatewayRevision((current) =>
        current === null ? incoming.revision! : Math.max(current, incoming.revision!),
      );
    }
    if (
      incoming.kind === "user" &&
      incoming.originDeviceId &&
      incoming.originDeviceId === matrixConnectionRef.current?.identity.keyId
    ) {
      // The local composer already rendered this prompt optimistically.
      return;
    }
    const message: ChatMessage = {
      id: incoming.eventId,
      eventId: incoming.eventId,
      kind: incoming.kind === "error" ? "error" : incoming.kind,
      text: incoming.text,
      time: formatMessageTime(incoming.timestamp),
      requestId: incoming.requestId,
      streamId: incoming.streamId,
      commandId: incoming.commandId,
      revision: incoming.revision,
      originDeviceId: incoming.originDeviceId,
      originDeviceName: incoming.originDeviceName,
      raw: incoming.raw,
    };
    if (incoming.requestId) {
      setDecisionStates((current) => ({
        ...current,
        [incoming.eventId]: "pending",
      }));
    }
    setMessages((current) => {
      if (
        incoming.commandId &&
        current.some((entry) => entry.commandId === incoming.commandId)
      ) {
        return current;
      }
      const eventType =
        typeof incoming.raw.type === "string" ? incoming.raw.type : "";
      const replaceIndex = incoming.replacesEventId
        ? current.findIndex(
            (entry) =>
              entry.eventId === incoming.replacesEventId ||
              entry.id === incoming.replacesEventId,
          )
        : -1;
      const streamIndex = incoming.streamId
        ? current.findIndex((entry) => entry.streamId === incoming.streamId)
        : -1;
      const targetIndex = replaceIndex >= 0 ? replaceIndex : streamIndex;
      if (targetIndex < 0) {
        if (incoming.kind === "user" && incoming.revision !== undefined) {
          const laterRevision = current.findIndex(
            (entry) =>
              entry.kind === "user" &&
              typeof entry.revision === "number" &&
              entry.revision > incoming.revision!,
          );
          if (laterRevision >= 0) {
            const ordered = [...current];
            ordered.splice(laterRevision, 0, message);
            return ordered;
          }
        }
        return [...current, message];
      }

      const next = [...current];
      if (
        eventType === "agent.text.delta" &&
        next[targetIndex].text !== incoming.text
      ) {
        next[targetIndex] = {
          ...message,
          id: next[targetIndex].id,
          text: `${next[targetIndex].text ?? ""}${incoming.text}`,
        };
      } else {
        next[targetIndex] = { ...message, id: next[targetIndex].id };
      }
      return next;
    });
    if (
      incoming.raw.type === "agent.text.completed" ||
      incoming.raw.type === "command.completed" ||
      (incoming.kind === "error" &&
        incoming.raw.kind !== "command_result")
    ) {
      setIsStreaming(false);
    }
  }

  async function connectRealMatrix(
    configInput = matrixConfig,
    closeSettings = true,
  ): Promise<MatrixConnection | null> {
    matrixConnectionRef.current?.stop();
    matrixConnectionRef.current = null;
    revisionConflictRef.current = null;
    setRevisionConflict(null);
    setConnectionError(null);
    setConnectionStatus("connecting");
    setMessages([]);
    setGatewayState(null);
    setGatewayRevision(null);
    currentSessionIdRef.current = null;
    try {
      const normalized = normalizeMatrixConfig(configInput);
      setMatrixConfig(normalized);
      saveMatrixConfig(normalized);
      const connection = await connectMatrix(normalized, {
        onMessage: receiveMatrixMessage,
        onStatus(status, detail) {
          setConnectionStatus(status);
          if (status === "error" && detail) setConnectionError(detail);
        },
        onTrustUpdated(trust) {
          setTrustedGateway(trust);
          setMatrixConfig((current) => ({
            ...current,
            ...trustedGatewayConfig(trust),
          }));
        },
        onCollaborationState(state) {
          if (state.gatewayState) {
            setActiveDeviceCount(state.gatewayState.activeDeviceCount);
            setGatewayRevision(state.gatewayState.revision);
          } else if (state.revision !== undefined) {
            setGatewayRevision((current) =>
              current === null
                ? state.revision!
                : Math.max(current, state.revision!),
            );
          }
          if (state.gatewayState) {
            const nextSessionId = state.gatewayState.currentSessionId;
            if (
              currentSessionIdRef.current !== null &&
              currentSessionIdRef.current !== nextSessionId
            ) {
              setMessages([]);
              setDecisionStates({});
              setIsStreaming(false);
            }
            currentSessionIdRef.current = nextSessionId;
            setGatewayState(state.gatewayState);
          }
        },
        onCommandResult(result) {
          completedCommandResultsRef.current.add(result.commandId);
          if (activePromptCommandIdRef.current === result.commandId) {
            activePromptCommandIdRef.current = null;
            completedCommandResultsRef.current.delete(result.commandId);
            setIsStreaming(false);
          }
        },
      });
      matrixConnectionRef.current = connection;
      setDeviceKeyId(connection.identity.keyId);
      if (closeSettings) setSettingsOpen(false);
      setMessages((current) => [
        {
          id: `matrix-connected-${Date.now()}`,
          kind: "notice",
          text: "Connected directly to an encrypted Matrix room. Commands are signed by this browser’s P-256 device key.",
          time: "now",
        },
        ...current,
      ]);
      return connection;
    } catch (error) {
      setConnectionStatus("error");
      setConnectionError(formatUiError(error));
      return null;
    }
  }

  function disconnectMatrix() {
    matrixConnectionRef.current?.stop();
    matrixConnectionRef.current = null;
    revisionConflictRef.current = null;
    activePromptCommandIdRef.current = null;
    completedCommandResultsRef.current.clear();
    setRevisionConflict(null);
    setConnectionStatus("offline");
    setIsStreaming(false);
    setGatewayState(null);
    setGatewayRevision(null);
    currentSessionIdRef.current = null;
  }

  function forgetMatrixConfig() {
    pairingAbortRef.current?.abort();
    disconnectMatrix();
    clearMatrixConfig();
    clearPendingPairing();
    clearTrustedGateway();
    setMatrixConfig(emptyMatrixConfig);
    setTrustedGateway(null);
    setActiveDeviceCount(null);
    setGatewayRevision(null);
    setGatewayState(null);
    currentSessionIdRef.current = null;
    setPairingPreview(null);
    setConnectionError(null);
    setMessages([]);
    setSettingsOpen(true);
  }

  async function openPairingLink(link: string) {
    setConnectionError(null);
    try {
      const preview = await inspectPairingLink(link);
      const transport = preview.transport;
      setPairingPreview(preview);
      setMatrixConfig((current) => ({
        ...bindCredentialsToHomeserver(current, transport.homeserver),
        roomId: transport.roomId,
        gatewayId: preview.gatewayId,
        conversationId: transport.roomId,
        gatewayMatrixUserId: transport.userId,
        gatewayMatrixDeviceId: transport.deviceId,
        gatewayMatrixEd25519: transport.ed25519,
      }));
      setSettingsOpen(true);
    } catch (error) {
      setConnectionError(formatUiError(error));
    }
  }

  async function confirmPairing(
    previewOverride: PairingPreview | null = pairingPreview,
    configOverride: MatrixConnectionConfig = matrixConfig,
  ) {
    if (!previewOverride || pairingBusy) return;
    pairingAbortRef.current?.abort();
    const abort = new AbortController();
    pairingAbortRef.current = abort;
    setPairingBusy(true);
    setConnectionError(null);
    try {
      const transport = previewOverride.transport;
      const unresolvedConfig: MatrixConnectionConfig = {
        ...configOverride,
        homeserver: transport.homeserver,
        roomId: transport.roomId,
        gatewayId: previewOverride.gatewayId,
        conversationId: transport.roomId,
        gatewayMatrixUserId: transport.userId,
        gatewayMatrixDeviceId: transport.deviceId,
        gatewayMatrixEd25519: transport.ed25519,
      };
      const configForPairing = await resolveMatrixSession(unresolvedConfig);
      setMatrixConfig(configForPairing);
      const connection = await connectRealMatrix(configForPairing, false);
      if (!connection) return;
      const trust = await connection.pair(
        previewOverride,
        browserDeviceName(),
        abort.signal,
      );
      const trustedConfig: MatrixConnectionConfig = {
        ...configForPairing,
        ...trustedGatewayConfig(trust),
      };
      saveTrustedGateway(trust);
      saveMatrixConfig(trustedConfig);
      setTrustedGateway(trust);
      setActiveDeviceCount(trust.activeDeviceCount ?? null);
      setMatrixConfig(trustedConfig);
      setPairingPreview(null);
      setSettingsOpen(false);
      setMessages((current) => [
        {
          id: `gateway-paired-${Date.now()}`,
          kind: "notice",
          text: `${trust.gatewayName} is now trusted. Future Matrix device rotations must be signed by its persistent Gateway key.`,
          time: "now",
        },
        ...current,
      ]);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setConnectionError(formatUiError(error));
      }
    } finally {
      if (pairingAbortRef.current === abort) pairingAbortRef.current = null;
      setPairingBusy(false);
    }
  }
  pairingRecoveryRef.current = confirmPairing;

  async function sendRealCommand(
    payload: CommandPayload,
  ): Promise<CommandSendResult | null> {
    const connection = matrixConnectionRef.current;
    if (!connection || connectionStatus !== "connected") {
      setConnectionError(
        "The Gateway is not connected. Open Gateway settings and reconnect.",
      );
      setSettingsOpen(true);
      return null;
    }
    try {
      const result = await connection.send(payload);
      revisionConflictRef.current = null;
      return result;
    } catch (error) {
      if (error instanceof CommandRevisionConflictError) {
        const notice: RevisionConflictNotice = {
          commandId: error.commandId,
          expectedRevision: error.expectedRevision,
          payload: error.payload,
          busy: false,
        };
        revisionConflictRef.current = notice;
        setRevisionConflict(notice);
        setConnectionError(null);
        return null;
      }
      setConnectionError(formatUiError(error));
      return null;
    }
  }

  async function confirmRevisionRetry() {
    const conflict = revisionConflictRef.current;
    const connection = matrixConnectionRef.current;
    if (!conflict || !connection || conflict.busy) return;
    const busyConflict = { ...conflict, busy: true };
    revisionConflictRef.current = busyConflict;
    setRevisionConflict(busyConflict);
    try {
      const result = await connection.confirmRevisionRetry(conflict.commandId);
      setGatewayRevision((current) =>
        current === null ? result.revision : Math.max(current, result.revision),
      );
      if (conflict.optimisticMessageId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === conflict.optimisticMessageId
              ? {
                  ...message,
                  commandId: result.commandId,
                  revision: result.revision,
                }
              : message,
          ),
        );
      }
      const completion =
        conflict.payload.operation === "prompt"
          ? null
          : await result.completion;
      if (completion?.outcome === "succeeded" &&
          conflict.payload.operation === "cancel") {
        setIsStreaming(false);
      } else if (
        completion?.outcome === "succeeded" &&
        conflict.payload.operation === "decision"
      ) {
        const requestId = conflict.payload.requestId;
        const decision = conflict.payload.decision;
        const request = messages.find(
          (message) => message.requestId === requestId,
        );
        if (request) {
          setDecisionStates((current) => ({
            ...current,
            [request.id]:
              decision === "deny" ? "denied" : "approved",
          }));
        }
      }
      revisionConflictRef.current = null;
      setRevisionConflict(null);
    } catch (error) {
      if (error instanceof CommandRevisionConflictError) {
        const next: RevisionConflictNotice = {
          commandId: error.commandId,
          expectedRevision: error.expectedRevision,
          payload: error.payload,
          optimisticMessageId: conflict.optimisticMessageId,
          busy: false,
        };
        revisionConflictRef.current = next;
        setRevisionConflict(next);
        return;
      }
      revisionConflictRef.current = { ...conflict, busy: false };
      setRevisionConflict({ ...conflict, busy: false });
      setConnectionError(formatUiError(error));
    }
  }

  async function discardRevisionConflict() {
    const conflict = revisionConflictRef.current;
    const connection = matrixConnectionRef.current;
    if (!conflict || !connection || conflict.busy) return;
    const busyConflict = { ...conflict, busy: true };
    revisionConflictRef.current = busyConflict;
    setRevisionConflict(busyConflict);
    try {
      await connection.discardRevisionConflict(conflict.commandId);
      if (conflict.optimisticMessageId) {
        setMessages((current) =>
          current.filter(
            (message) => message.id !== conflict.optimisticMessageId,
          ),
        );
      }
      revisionConflictRef.current = null;
      setRevisionConflict(null);
    } catch (error) {
      revisionConflictRef.current = { ...conflict, busy: false };
      setRevisionConflict({ ...conflict, busy: false });
      setConnectionError(formatUiError(error));
    }
  }

  async function chooseSession(id: string) {
    setMobileChatOpen(true);
    if (id === gatewayState?.currentSessionId) return;
    if (!gatewayState?.capabilities.canSelectSession) {
      setConnectionError("This Gateway does not support switching sessions.");
      return;
    }
    const sent = await sendRealCommand({
      operation: "session.select",
      sessionId: id,
    });
    if (sent) await sent.completion;
  }

  async function createSession(input: NewSessionInput) {
    if (!gatewayState?.capabilities.canCreateSession) {
      setConnectionError(
        gatewayState
          ? "This Gateway does not support creating sessions."
          : "Waiting for the current Gateway session state.",
      );
      return;
    }
    setNewSessionBusy(true);
    try {
      const sent = await sendRealCommand({
        operation: "session.create",
        cwd: input.cwd,
        projectName: input.projectName,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
      });
      if (sent && (await sent.completion).outcome === "succeeded") {
        setNewSessionOpen(false);
        setMobileChatOpen(true);
      }
    } finally {
      setNewSessionBusy(false);
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const value = draft.trim();
    if (!value || isStreaming) return;
    if (!matrixConnected || !gatewayState) {
      setConnectionError(
        !gatewayState && matrixConnected
          ? "Waiting for the current Gateway session state."
          : trustedGateway
          ? "The Gateway is offline. Reconnect before sending."
          : "Add and pair a Gateway before sending your first message.",
      );
      setSettingsOpen(true);
      return;
    }
    const optimisticId = `user-${Date.now()}-${crypto.randomUUID()}`;
    followLatestRef.current = true;
    setMessages((current) => [
      ...current,
      { id: optimisticId, kind: "user", text: value, time: "now" },
    ]);
    setDraft("");
    setIsStreaming(true);
    const result = await sendRealCommand({
      operation: "prompt",
      text: value,
    });
    if (!result) {
      activePromptCommandIdRef.current = null;
      setIsStreaming(false);
      if (revisionConflictRef.current) {
        const conflict = revisionConflictRef.current;
        const matchesCurrentPrompt =
          conflict.payload.operation === "prompt" &&
          conflict.payload.text === value;
        const next = matchesCurrentPrompt
          ? { ...conflict, optimisticMessageId: optimisticId }
          : conflict;
        revisionConflictRef.current = next;
        setRevisionConflict(next);
        if (!matchesCurrentPrompt) {
          setMessages((current) =>
            current.filter((message) => message.id !== optimisticId),
          );
          setDraft(value);
        }
      } else {
        setMessages((current) => [
          ...current,
          {
            id: `matrix-error-${Date.now()}`,
            kind: "error",
            text: "The signed command was not sent. Check Matrix connection settings.",
            time: "now",
          },
        ]);
      }
    } else {
      if (completedCommandResultsRef.current.delete(result.commandId)) {
        activePromptCommandIdRef.current = null;
        setIsStreaming(false);
      } else {
        activePromptCommandIdRef.current = result.commandId;
      }
      setMessages((current) =>
        current.map((message) =>
          message.id === optimisticId
            ? {
                ...message,
                commandId: result.commandId,
                revision: result.revision,
                originDeviceId: deviceKeyId ?? undefined,
                originDeviceName:
                  trustedGateway?.certificate.certificate.deviceName,
              }
            : message,
        ),
      );
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function stopStreaming() {
    const sent = await sendRealCommand({ operation: "cancel" });
    if (sent && (await sent.completion).outcome === "succeeded") {
      setIsStreaming(false);
    }
  }

  async function decidePermission(
    message: ChatMessage,
    decision: "allow_once" | "deny",
  ) {
    if (!message.requestId) {
      setConnectionError("This permission request has no signed request ID.");
      return;
    }
    const sent = await sendRealCommand({
      operation: "decision",
      requestId: message.requestId,
      decision,
    });
    if (sent && (await sent.completion).outcome === "succeeded") {
      setDecisionStates((current) => ({
        ...current,
        [message.id]: decision === "allow_once" ? "approved" : "denied",
      }));
    }
  }

  async function changeModel(nextModel: string) {
    const sent = await sendRealCommand({
      operation: "session.settings",
      model: nextModel,
    });
    if (sent) await sent.completion;
  }

  async function changeReasoningEffort(nextReasoningEffort: string) {
    const sent = await sendRealCommand({
      operation: "session.settings",
      reasoningEffort: nextReasoningEffort,
    });
    if (sent) await sent.completion;
  }

  async function changeMode(nextMode: string) {
    const sent = await sendRealCommand({
      operation: "session.settings",
      permissionMode: nextMode as
        | "default"
        | "accept_edits"
        | "plan"
        | "bypass_permissions",
    });
    if (sent) await sent.completion;
  }

  return (
    <main className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""}`}>
      <aside className="rail" aria-label="Primary navigation">
        <div className="brand" title="Codever">
          <span>⌁</span>
        </div>
        <nav className="rail-nav">
          <button className="rail-button active" aria-label="Chats">
            <Icon>◫</Icon>
            <span>Chats</span>
          </button>
          <button className="rail-button" aria-label="Tasks">
            <Icon>✓</Icon>
            <span>Tasks</span>
          </button>
          <button className="rail-button" aria-label="Files">
            <Icon>▱</Icon>
            <span>Files</span>
          </button>
        </nav>
        <div className="rail-spacer" />
        <button className="rail-button" aria-label="Settings">
          <Icon>⚙</Icon>
          <span>Settings</span>
        </button>
        <div className="profile-avatar" title="Alex · verified device">
          AK
          <span className="presence-dot" />
        </div>
      </aside>

      <section className="session-panel" aria-label="Conversations">
        <header className="session-header">
          <div>
            <span className="eyebrow">Workspace</span>
            <h1>Codever</h1>
          </div>
          <button
            className="round-button"
            aria-label="New conversation"
            onClick={() => setNewSessionOpen(true)}
            disabled={
              !matrixConnected ||
              !gatewayState?.capabilities.canCreateSession
            }
          >
            +
          </button>
        </header>

        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
          <kbd>⌘ K</kbd>
        </label>

        <button
          className={`gateway-card gateway-card-button ${matrixConnected ? "" : "offline"}`}
          onClick={() => setSettingsOpen(true)}
        >
          <span className="gateway-icon">G</span>
          <div>
            <strong>
              {trustedGateway?.gatewayName || "Add a Gateway"}
            </strong>
            <span>
              <i />{" "}
              {connectionStatus === "connected"
                ? "Securely connected"
                : connectionStatus === "reconnecting"
                  ? "Reconnecting securely"
                  : trustedGateway
                    ? "Gateway offline · open to reconnect"
                    : "Scan QR or paste a one-time pairing link"}
            </span>
          </div>
          <span className="gateway-more" aria-hidden="true">•••</span>
        </button>

        <div className="session-section-label">
          <span>Recent</span>
          <span>{gatewayState?.sessions.length ?? 0}</span>
        </div>

        <div className="session-list">
          {projectGroups.length > 0 && (
            <div className="gateway-group-heading">
              <span className="gateway-group-mark">G</span>
              <span>
                <strong>{trustedGateway?.gatewayName || "Gateway"}</strong>
                <small>{matrixConfig.gatewayId}</small>
              </span>
            </div>
          )}
          {projectGroups.map((project) => (
            <section className="project-session-group" key={project.key}>
              <header>
                <span className="project-folder">⌘</span>
                <span>
                  <strong>{project.projectName}</strong>
                  <small>{project.cwd}</small>
                </span>
                <b>{project.sessions.length}</b>
              </header>
              {project.sessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-row ${
                    gatewayState?.currentSessionId === session.id
                      ? "selected"
                      : ""
                  }`}
                  onClick={() => void chooseSession(session.id)}
                  disabled={
                    gatewayState?.currentSessionId !== session.id &&
                    !gatewayState?.capabilities.canSelectSession
                  }
                >
                  <span className="session-avatar violet">
                    {sessionInitials(session.title)}
                    {matrixConnected &&
                      gatewayState?.currentSessionId === session.id && (
                        <i className="agent-active" />
                      )}
                  </span>
                  <span className="session-copy">
                    <span className="session-title-line">
                      <strong>{session.title}</strong>
                      <time>{formatSessionTime(session.updatedAt)}</time>
                    </span>
                    <span className="session-preview-line">
                      <span>
                        {session.provider}
                        {session.model ? ` · ${session.model}` : ""}
                        {session.reasoningEffort
                          ? ` · ${session.reasoningEffort}`
                          : ""}
                      </span>
                    </span>
                  </span>
                </button>
              ))}
            </section>
          ))}
          {!trustedGateway && (
            <div className="empty-search">
              <span>G</span>
              Add a Gateway to start your first secure conversation
            </div>
          )}
          {trustedGateway && !gatewayState && (
            <div className="empty-search">
              <span>↻</span>
              Syncing current Gateway state…
            </div>
          )}
          {gatewayState &&
            gatewayState.sessions.length > 0 &&
            filteredSessions.length === 0 && (
            <div className="empty-search">
              <span>⌕</span>
              No matching conversations
            </div>
          )}
          {gatewayState && gatewayState.sessions.length === 0 && (
            <div className="empty-search">
              <span>+</span>
              Create your first secure conversation
            </div>
          )}
        </div>

        <footer className="trust-footer">
          <span className="shield">✓</span>
          <span>
            <strong>Matrix E2EE + P-256</strong>
            <small>
              {deviceKeyId
                ? `${matrixConnected ? "This device online" : "This device offline"} · ${
                    activeDeviceCount === null
                      ? "device count pending"
                      : `${activeDeviceCount} trusted ${
                          activeDeviceCount === 1 ? "device" : "devices"
                        }`
                  } · ${
                    gatewayRevision === null
                      ? "syncing state"
                      : `r${gatewayRevision}`
                  }`
                : "Local device key not loaded"}
            </small>
          </span>
          <button
            aria-label="View trusted devices"
            onClick={() => setSettingsOpen(true)}
          >
            ›
          </button>
        </footer>
      </section>

      <section className="conversation-panel" aria-label={conversationTitle}>
        <header className="conversation-header">
          <button
            className="mobile-back"
            onClick={() => setMobileChatOpen(false)}
            aria-label="Back to conversations"
          >
            ‹
          </button>
          <span className="conversation-avatar violet">
            {sessionInitials(conversationTitle)}
          </span>
          <div className="conversation-heading">
            <h2>{conversationTitle}</h2>
            <span>
              <i className={matrixConnected ? "" : "offline-dot"} />{" "}
              {connectionStatus === "connected"
                ? gatewayState
                  ? `${activeProvider} · encrypted sync active`
                  : "Syncing Gateway state…"
                : connectionStatus}
            </span>
          </div>
          <div className="header-actions">
            <button className="header-button" aria-label="Search in conversation">
              ⌕
            </button>
            <button
              className={`header-button ${detailsOpen ? "pressed" : ""}`}
              aria-label="Conversation details"
              onClick={() => setDetailsOpen((value) => !value)}
            >
              ⋯
            </button>
          </div>
        </header>

        {detailsOpen && (
          <div className="details-popover">
            <span className="mini-label">Project</span>
            <strong>
              {gatewayState?.workspace.projectName || "Syncing…"}
            </strong>
            <code>{gatewayState?.workspace.cwd || "Syncing…"}</code>
            <span className="mini-label">Gateway</span>
            <code>{matrixConfig.gatewayId || "Not connected"}</code>
            <span className="mini-label">Device</span>
            <code>{matrixConfig.matrixDeviceId || "Not connected"}</code>
            <span className="verified-line">
              <b>✓</b> Commands signed locally
            </span>
          </div>
        )}

        <div
          className="chat-feed"
          ref={feedRef}
          onScroll={(event) => {
            const feed = event.currentTarget;
            const remaining =
              feed.scrollHeight - feed.scrollTop - feed.clientHeight;
            followLatestRef.current = remaining <= 48;
          }}
        >
          <div className="date-divider">
            <span>Today</span>
          </div>
          {messages.map((message) => {
            if (message.kind === "notice") {
              return (
                <div className="encryption-notice" key={message.id}>
                  <span className="shield">✓</span>
                  <span>{message.text}</span>
                </div>
              );
            }
            if (message.kind === "error") {
              return (
                <div className="message-row agent-row" key={message.id}>
                  <div className="agent-mark error-mark">!</div>
                  <div className="bubble agent-bubble error-bubble">
                    <span className="agent-label">CONNECTION ERROR</span>
                    <p>{message.text}</p>
                    <time>{message.time}</time>
                  </div>
                </div>
              );
            }
            if (message.kind === "user") {
              return (
                <div className="message-row user-row" key={message.id}>
                  <div className="bubble user-bubble">
                    {message.originDeviceName &&
                      message.originDeviceId !== deviceKeyId && (
                        <span className="collaborator-label">
                          {message.originDeviceName}
                        </span>
                      )}
                    <p>{message.text}</p>
                    <time>
                      {message.revision !== undefined
                        ? `r${message.revision} · ${message.time ?? ""}`
                        : message.time}{" "}
                      <span>✓✓</span>
                    </time>
                  </div>
                </div>
              );
            }
            if (message.kind === "tool") {
              return (
                <div className="message-row agent-row" key={message.id}>
                  <div className="agent-mark">C</div>
                  <div className="tool-card">
                    <div className="tool-heading">
                      <span className="terminal-mark">&gt;_</span>
                      <span>
                        <strong>{message.text || "Agent tool"}</strong>
                        <small>Received from encrypted room</small>
                      </span>
                      <b>✓</b>
                    </div>
                    <div className="tool-command">
                      <code>
                        {JSON.stringify(message.raw ?? {}).slice(0, 180)}
                      </code>
                    </div>
                    <button>Encrypted event details</button>
                  </div>
                </div>
              );
            }
            if (message.kind === "permission") {
              const decisionState =
                decisionStates[message.id] ?? "pending";
              return (
                <div className="message-row agent-row" key={message.id}>
                  <div className="agent-mark">C</div>
                  <div className="permission-card">
                    <div className="permission-title">
                      <span>!</span>
                      <div>
                        <strong>{message.text || "Permission required"}</strong>
                        <small>Signed response required</small>
                      </div>
                    </div>
                    <p>
                      This decision will be signed by your local Codever key and
                      sent through the encrypted room.
                    </p>
                    {decisionState === "pending" ? (
                      <div className="permission-actions">
                        <button
                          className="approve-button"
                          onClick={() => void decidePermission(message, "allow_once")}
                        >
                          Allow once
                        </button>
                        <button
                          className="deny-button"
                          onClick={() => void decidePermission(message, "deny")}
                        >
                          Deny
                        </button>
                      </div>
                    ) : (
                      <div className={`decision-state ${decisionState}`}>
                        {decisionState === "approved"
                          ? "✓ Allowed once"
                          : "× Denied"}
                      </div>
                    )}
                    <time>{message.time}</time>
                  </div>
                </div>
              );
            }
            return (
              <div className="message-row agent-row" key={message.id}>
                <div className="agent-mark">C</div>
                <div className="bubble agent-bubble">
                  <span className="agent-label">CODEX</span>
                  <p>{message.text}</p>
                  <time>{message.time}</time>
                </div>
              </div>
            );
          })}

        </div>

        <div className="composer-area">
          <div className="context-strip">
            <div className="context-item">
              <span className="context-icon">⌘</span>
              <span>
                <small>Project · Gateway</small>
                <b title={gatewayState?.workspace.cwd}>
                  {gatewayState?.workspace.projectName || "Syncing Gateway state…"}
                  {trustedGateway ? ` · ${trustedGateway.gatewayName}` : ""}
                </b>
              </span>
            </div>
            <div className="context-item branch-item">
              <span className="branch-mark">⑂</span>
              <code>{gatewayState?.workspace.provider || "Gateway"}</code>
            </div>
            <span className="context-spacer" />
          </div>

          {revisionConflict && (
            <section className="revision-conflict-card" role="alert">
              <div>
                <strong>Another device updated this session</strong>
                <p>
                  {describeConflictedAction(revisionConflict.payload)} was not
                  replayed. Review the latest messages, then choose whether to
                  sign and send it against revision{" "}
                  {revisionConflict.expectedRevision}.
                </p>
              </div>
              <div className="revision-conflict-actions">
                <button
                  type="button"
                  disabled={revisionConflict.busy}
                  onClick={() => void discardRevisionConflict()}
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={revisionConflict.busy}
                  onClick={() => void confirmRevisionRetry()}
                >
                  {revisionConflict.busy ? "Checking…" : "Review complete · send"}
                </button>
              </div>
            </section>
          )}

          <form
            className="composer"
            onSubmit={(event) => void sendMessage(event)}
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={
                matrixConnected
                  ? `Message ${activeProvider}…`
                  : trustedGateway
                    ? "Reconnect your Gateway to send messages"
                    : "Add a Gateway to start"
              }
              aria-label={`Message ${activeProvider}`}
              rows={1}
              disabled={!matrixConnected}
            />
            <div className="composer-actions">
              <button
                type="button"
                className="attachment-button"
                aria-label="Attach a file"
                onClick={() =>
                  setConnectionError(
                    "Encrypted attachment upload is not available in this milestone.",
                  )
                }
              >
                +
              </button>
              <div className="agent-controls">
                <label>
                  <span className="status-spark" />
                  <select
                    value={gatewayState?.workspace.model ?? ""}
                    onChange={(event) => void changeModel(event.target.value)}
                    aria-label="Agent model"
                    disabled={
                      !sessionReady ||
                      gatewayState!.capabilities.models.length === 0
                    }
                  >
                    {!gatewayState?.workspace.model && (
                      <option value="">Gateway default</option>
                    )}
                    {(gatewayState?.capabilities.models ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="control-divider" />
                <label>
                  <select
                    value={
                      gatewayState?.workspace.reasoningEffort ??
                      activeModelCapability?.defaultReasoningLevel ??
                      ""
                    }
                    onChange={(event) =>
                      void changeReasoningEffort(event.target.value)
                    }
                    aria-label="Reasoning effort"
                    title="Reasoning effort"
                    disabled={
                      !sessionReady ||
                      !activeModelCapability ||
                      activeModelCapability.supportedReasoningLevels.length === 0
                    }
                  >
                    {!activeModelCapability && (
                      <option value="">Reasoning</option>
                    )}
                    {(activeModelCapability?.supportedReasoningLevels ?? []).map(
                      (level) => (
                        <option key={level.effort} value={level.effort}>
                          {level.effort}
                          {level.effort ===
                          activeModelCapability?.defaultReasoningLevel
                            ? " (default)"
                            : ""}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                {(gatewayState?.capabilities.permissionModes.length ?? 0) >
                  1 && (
                  <>
                    <span className="control-divider" />
                    <label>
                      <select
                        value={gatewayState?.workspace.permissionMode ?? ""}
                        onChange={(event) => void changeMode(event.target.value)}
                        aria-label="Permission mode"
                        title="Permission mode"
                        disabled={
                          !sessionReady ||
                          gatewayState!.capabilities.permissionModes.length === 0
                        }
                      >
                        {!gatewayState && <option value="">Syncing…</option>}
                        {(gatewayState?.capabilities.permissionModes ?? []).map(
                          (mode) => (
                            <option key={mode.id} value={mode.id}>
                              {mode.name}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  </>
                )}
              </div>
              {isStreaming ? (
                <button
                  type="button"
                  className="send-button stop-button"
                  onClick={() => void stopStreaming()}
                  aria-label="Stop agent"
                >
                  ■
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  disabled={!draft.trim() || !sessionReady}
                  aria-label="Send message"
                >
                  ↑
                </button>
              )}
            </div>
          </form>
          <p className="composer-hint">
            Signed locally · Matrix E2EE transport · Enter to send
          </p>
        </div>
      </section>

      {connectionError && !settingsOpen && (
        <button
          className="connection-toast"
          role="alert"
          onClick={() => setSettingsOpen(true)}
        >
          <span>!</span>
          <span>
            <strong>Matrix needs attention</strong>
            <small>{connectionError}</small>
          </span>
          <b>Open settings</b>
        </button>
      )}

      {gatewayState && (
        <NewSessionDialog
          open={newSessionOpen}
          busy={newSessionBusy}
          gatewayId={matrixConfig.gatewayId}
          gatewayName={trustedGateway?.gatewayName || "Gateway"}
          workspace={gatewayState.workspace}
          sessions={gatewayState.sessions}
          models={gatewayState.capabilities.models}
          onClose={() => {
            if (!newSessionBusy) setNewSessionOpen(false);
          }}
          onCreate={(input) => void createSession(input)}
        />
      )}

      <MatrixSettings
        open={settingsOpen}
        config={matrixConfig}
        status={connectionStatus}
        error={connectionError}
        pairingPreview={pairingPreview}
        trustedGateway={trustedGateway}
        pairingBusy={pairingBusy}
        onChange={setMatrixConfig}
        onPairingLink={(link) => void openPairingLink(link)}
        onClearPairing={() => {
          pairingAbortRef.current?.abort();
          setPairingPreview(null);
          setConnectionError(null);
        }}
        onConfirmPairing={() => void confirmPairing()}
        onClose={() => setSettingsOpen(false)}
        onConnect={() => void connectRealMatrix()}
        onDisconnect={() => disconnectMatrix()}
        onForget={forgetMatrixConfig}
      />
    </main>
  );
}

function formatMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return formatMessageTime(timestamp);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function sessionInitials(title: string): string {
  const initials = title
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "CV";
}

function describeConflictedAction(payload: CommandPayload): string {
  switch (payload.operation) {
    case "prompt":
      return `Your prompt “${payload.text.slice(0, 80)}${
        payload.text.length > 80 ? "…" : ""
      }”`;
    case "cancel":
      return "The cancel action";
    case "decision":
      return `The ${payload.decision.replaceAll("_", " ")} permission decision`;
    case "session.settings":
      return "The session settings change";
    case "session.create":
      return "The new session request";
    case "session.select":
      return "The session switch";
  }
}

function formatUiError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function browserDeviceName(): string {
  const userAgentData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  const platform =
    userAgentData?.platform ||
    navigator.platform ||
    "Web device";
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return `Codever ${mobile ? "mobile" : "desktop"} · ${platform}`;
}
