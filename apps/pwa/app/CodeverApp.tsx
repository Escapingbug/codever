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

type Session = {
  id: string;
  initials: string;
  color: string;
  title: string;
  preview: string;
  time: string;
  unread?: number;
  active?: boolean;
  provider: string;
  model: string;
  repository: string;
  branch: string;
};

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

const sessions: Session[] = [
  {
    id: "matrix-rewrite",
    initials: "CV",
    color: "violet",
    title: "Matrix PWA rewrite",
    preview: "Waiting for permission to edit 3 files",
    time: "now",
    unread: 1,
    active: true,
    provider: "Codex",
    model: "GPT-5.2 Codex",
    repository: "escapingbug/codever",
    branch: "rewrite/matrix-pwa",
  },
  {
    id: "release",
    initials: "RL",
    color: "blue",
    title: "Prepare v0.4 release",
    preview: "All 128 tests passed. Ready to tag.",
    time: "10:42",
    provider: "Claude Code",
    model: "Claude Sonnet 4",
    repository: "codever/desktop",
    branch: "release/0.4",
  },
  {
    id: "security",
    initials: "SC",
    color: "green",
    title: "Security review",
    preview: "I found two places to harden nonce validation.",
    time: "Mon",
    unread: 3,
    provider: "Codex",
    model: "GPT-5.2 Codex",
    repository: "escapingbug/codever",
    branch: "security/device-trust",
  },
  {
    id: "ios",
    initials: "MB",
    color: "orange",
    title: "Mobile layout polish",
    preview: "The safe-area and keyboard fixes are in.",
    time: "Sun",
    provider: "Cursor Agent",
    model: "Composer",
    repository: "codever/pwa",
    branch: "feat/mobile-shell",
  },
  {
    id: "docs",
    initials: "DX",
    color: "pink",
    title: "Protocol documentation",
    preview: "Updated the encrypted envelope examples.",
    time: "Fri",
    provider: "OpenCode",
    model: "Gemini 3 Pro",
    repository: "codever/protocol",
    branch: "docs/envelopes",
  },
];

const initialMessages: ChatMessage[] = [
  {
    id: "notice",
    kind: "notice",
    text: "Messages and agent commands are end-to-end encrypted. Only your trusted devices can read or authorize them.",
  },
  {
    id: "user-1",
    kind: "user",
    text: "Build the first PWA screen from the architecture plan. Keep it familiar like Telegram, but make agent state and trust obvious.",
    time: "10:36",
  },
  {
    id: "agent-1",
    kind: "agent",
    text: "I’ll turn the starter into a responsive three-pane workspace, then add a local interaction model for sessions, permissions, and streaming responses.",
    time: "10:36",
  },
  { id: "tool-1", kind: "tool", time: "10:37" },
  {
    id: "agent-2",
    kind: "agent",
    text: "The app shell and mobile navigation are in place. I’m ready to update the PWA metadata and offline cache next.",
    time: "10:38",
  },
  { id: "permission-1", kind: "permission", time: "10:38" },
];

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <span className="icon" aria-hidden="true">
      {children}
    </span>
  );
}

export function CodeverApp() {
  const [appMode, setAppMode] = useState<"demo" | "matrix">("matrix");
  const [selectedId, setSelectedId] = useState(sessions[0].id);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [permission, setPermission] = useState<
    "pending" | "approved" | "denied"
  >("pending");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [model, setModel] = useState(sessions[0].model);
  const [mode, setMode] = useState("Agent");
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
  const [gatewayRevision, setGatewayRevision] = useState(0);
  const [revisionConflict, setRevisionConflict] =
    useState<RevisionConflictNotice | null>(null);
  const [pairingPreview, setPairingPreview] =
    useState<PairingPreview | null>(null);
  const [trustedGateway, setTrustedGateway] =
    useState<TrustedGateway | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [decisionStates, setDecisionStates] = useState<
    Record<string, "pending" | "approved" | "denied">
  >({});
  const feedRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const responseDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const selected =
    sessions.find((session) => session.id === selectedId) ?? sessions[0];
  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) =>
        `${session.title} ${session.preview} ${session.repository}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [search],
  );
  const matrixConnected =
    connectionStatus === "connected" || connectionStatus === "reconnecting";
  const conversationTitle =
    appMode === "matrix"
      ? trustedGateway
        ? matrixConfig.roomId || "Encrypted Matrix room"
        : "Add a Gateway"
      : selected.title;
  const activeProvider = appMode === "matrix" ? "Gateway agent" : selected.provider;

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
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, streamText, isStreaming]);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (responseDelayRef.current) clearTimeout(responseDelayRef.current);
      pairingAbortRef.current?.abort();
      matrixConnectionRef.current?.stop();
    },
    [],
  );

  function receiveMatrixMessage(incoming: IncomingCodeverMessage) {
    if (incoming.activeDeviceCount) {
      setActiveDeviceCount(incoming.activeDeviceCount);
    }
    if (incoming.revision) {
      setGatewayRevision((current) => Math.max(current, incoming.revision ?? 0));
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
        if (incoming.kind === "user" && incoming.revision) {
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
          if (state.activeDeviceCount) {
            setActiveDeviceCount(state.activeDeviceCount);
          }
          if (state.revision) {
            setGatewayRevision((current) =>
              Math.max(current, state.revision ?? 0),
            );
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
      setAppMode("matrix");
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
    setGatewayRevision(0);
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
      setGatewayRevision((current) => Math.max(current, result.revision));
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
      } else if (
        completion?.outcome === "succeeded" &&
        conflict.payload.operation === "session.settings"
      ) {
        if (conflict.payload.model) setModel(conflict.payload.model);
        if (conflict.payload.permissionMode) {
          setMode(
            conflict.payload.permissionMode === "plan" ? "Plan" : "Agent",
          );
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

  function chooseSession(id: string) {
    if (appMode === "matrix") {
      setMobileChatOpen(true);
      return;
    }
    const next = sessions.find((session) => session.id === id);
    if (timerRef.current) clearInterval(timerRef.current);
    if (responseDelayRef.current) clearTimeout(responseDelayRef.current);
    timerRef.current = null;
    responseDelayRef.current = null;
    setIsStreaming(false);
    setStreamText("");
    setSelectedId(id);
    setModel(next?.model ?? sessions[0].model);
    setMobileChatOpen(true);
    if (id === sessions[0].id) {
      setPermission("pending");
      setMessages(initialMessages);
      return;
    }
    setPermission("approved");
    setMessages([
      {
        id: `${id}-notice`,
        kind: "notice",
        text: "This session is secured by your verified device keys.",
      },
      {
        id: `${id}-agent`,
        kind: "agent",
        text: next?.preview ?? "Session ready.",
        time: next?.time,
      },
    ]);
  }

  function startMockResponse() {
    const response =
      "I’m on it. I’ll inspect the current context, make the smallest safe change, and report back with the verification result.";
    let cursor = 0;
    setStreamText("");
    responseDelayRef.current = null;
    timerRef.current = setInterval(() => {
      cursor += 2;
      setStreamText(response.slice(0, cursor));
      if (cursor >= response.length) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setMessages((current) => [
          ...current,
          {
            id: `agent-${Date.now()}`,
            kind: "agent",
            text: response,
            time: "now",
          },
        ]);
        setStreamText("");
        setIsStreaming(false);
      }
    }, 28);
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const value = draft.trim();
    if (!value || isStreaming) return;
    if (appMode === "matrix" && !matrixConnected) {
      setConnectionError(
        trustedGateway
          ? "The Gateway is offline. Reconnect before sending."
          : "Add and pair a Gateway before sending your first message.",
      );
      setSettingsOpen(true);
      return;
    }
    const optimisticId = `user-${Date.now()}-${crypto.randomUUID()}`;
    setMessages((current) => [
      ...current,
      { id: optimisticId, kind: "user", text: value, time: "now" },
    ]);
    setDraft("");
    setIsStreaming(true);
    if (appMode === "matrix") {
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
      return;
    }
    responseDelayRef.current = setTimeout(startMockResponse, 350);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function stopStreaming() {
    if (appMode === "matrix") {
      const sent = await sendRealCommand({ operation: "cancel" });
      if (sent && (await sent.completion).outcome === "succeeded") {
        setIsStreaming(false);
      }
      return;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    if (responseDelayRef.current) clearTimeout(responseDelayRef.current);
    timerRef.current = null;
    responseDelayRef.current = null;
    if (streamText) {
      setMessages((current) => [
        ...current,
        {
          id: `agent-stopped-${Date.now()}`,
          kind: "agent",
          text: `${streamText} — stopped`,
          time: "now",
        },
      ]);
    }
    setStreamText("");
    setIsStreaming(false);
  }

  async function decidePermission(
    message: ChatMessage,
    decision: "allow_once" | "deny",
  ) {
    if (appMode === "demo") {
      setPermission(decision === "allow_once" ? "approved" : "denied");
      return;
    }
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
    if (appMode === "matrix") {
      const sent = await sendRealCommand({
        operation: "session.settings",
        model: nextModel,
      });
      if (sent && (await sent.completion).outcome === "succeeded") {
        setModel(nextModel);
      }
      return;
    }
    setModel(nextModel);
  }

  async function changeMode(nextMode: string) {
    if (appMode === "matrix" && nextMode !== "Ask") {
      const sent = await sendRealCommand({
        operation: "session.settings",
        permissionMode: nextMode === "Plan" ? "plan" : "default",
      });
      if (sent && (await sent.completion).outcome === "succeeded") {
        setMode(nextMode);
      }
      return;
    }
    setMode(nextMode);
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
          <button className="round-button" aria-label="New conversation">
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
          <span>
            {appMode === "matrix" ? (trustedGateway ? 1 : 0) : filteredSessions.length}
          </span>
        </div>

        <div className="session-list">
          {(appMode === "matrix"
            ? trustedGateway
              ? sessions.slice(0, 1)
              : []
            : filteredSessions
          ).map((session) => (
            <button
              key={session.id}
              className={`session-row ${
                selectedId === session.id ? "selected" : ""
              }`}
              onClick={() => chooseSession(session.id)}
            >
              <span className={`session-avatar ${session.color}`}>
                {session.initials}
                {(appMode === "matrix" ? matrixConnected : session.active) && (
                  <i className="agent-active" />
                )}
              </span>
              <span className="session-copy">
                <span className="session-title-line">
                  <strong>
                    {appMode === "matrix"
                      ? matrixConfig.roomId || "Encrypted Matrix room"
                      : session.title}
                  </strong>
                  <time>{session.time}</time>
                </span>
                <span className="session-preview-line">
                  <span>
                    {appMode === "matrix"
                      ? "Live encrypted session · signed commands"
                      : session.preview}
                  </span>
                  {appMode === "demo" && session.unread && <b>{session.unread}</b>}
                </span>
              </span>
            </button>
          ))}
          {appMode === "matrix" && !trustedGateway && (
            <div className="empty-search">
              <span>G</span>
              Add a Gateway to start your first secure conversation
            </div>
          )}
          {appMode === "demo" && filteredSessions.length === 0 && (
            <div className="empty-search">
              <span>⌕</span>
              No matching conversations
            </div>
          )}
        </div>

        <footer className="trust-footer">
          <span className="shield">✓</span>
          <span>
            <strong>
              {appMode === "matrix" ? "Matrix E2EE + P-256" : "Encryption active"}
            </strong>
            <small>
              {appMode === "matrix"
                ? deviceKeyId
                  ? `${matrixConnected ? "This device online" : "This device offline"} · ${
                      activeDeviceCount === null
                        ? "device count pending"
                        : `${activeDeviceCount} active ${
                            activeDeviceCount === 1 ? "device" : "devices"
                          }`
                    } · r${gatewayRevision}`
                  : "Local device key not loaded"
                : "4 trusted devices"}
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
          <span className={`conversation-avatar ${selected.color}`}>
            {selected.initials}
          </span>
          <div className="conversation-heading">
            <h2>{conversationTitle}</h2>
            <span>
              <i className={matrixConnected ? "" : "offline-dot"} />{" "}
              {appMode === "matrix"
                ? connectionStatus === "connected"
                  ? "Encrypted sync active"
                  : connectionStatus
                : `${selected.provider} is ready`}
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
            <span className="mini-label">
              {appMode === "matrix" ? "Homeserver" : "Repository"}
            </span>
            <strong>
              {appMode === "matrix"
                ? matrixConfig.homeserver
                : selected.repository}
            </strong>
            <span className="mini-label">
              {appMode === "matrix" ? "Device" : "Branch"}
            </span>
            <code>
              {appMode === "matrix"
                ? matrixConfig.matrixDeviceId
                : selected.branch}
            </code>
            <span className="verified-line">
              <b>✓</b>{" "}
              {appMode === "matrix"
                ? "Commands signed locally"
                : "Gateway identity verified"}
            </span>
          </div>
        )}

        <div className="chat-feed" ref={feedRef}>
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
                      {message.revision
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
                        <small>
                          {appMode === "matrix"
                            ? "Received from encrypted room"
                            : "Completed in 1.8s"}
                        </small>
                      </span>
                      <b>✓</b>
                    </div>
                    <div className="tool-command">
                      <code>
                        {appMode === "matrix"
                          ? JSON.stringify(message.raw ?? {}).slice(0, 180)
                          : "rg --files apps/pwa"}
                      </code>
                    </div>
                    <button>
                      {appMode === "matrix" ? "Encrypted event details" : "View 24 files"}
                    </button>
                  </div>
                </div>
              );
            }
            if (message.kind === "permission") {
              const decisionState =
                appMode === "matrix"
                  ? decisionStates[message.id] ?? "pending"
                  : permission;
              return (
                <div className="message-row agent-row" key={message.id}>
                  <div className="agent-mark">C</div>
                  <div className="permission-card">
                    <div className="permission-title">
                      <span>!</span>
                      <div>
                        <strong>{message.text || "Permission required"}</strong>
                        <small>
                          {appMode === "matrix"
                            ? "Signed response required"
                            : "Write access · 3 files"}
                        </small>
                      </div>
                    </div>
                    <p>
                      {appMode === "matrix"
                        ? "This decision will be signed by your local Codever key and sent through the encrypted room."
                        : "Allow Codex to update the PWA screen, metadata, and offline shell?"}
                    </p>
                    {appMode === "demo" && (
                      <div className="file-list">
                        <code>app/CodeverApp.tsx</code>
                        <code>app/globals.css</code>
                        <code>public/sw.js</code>
                      </div>
                    )}
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

          {isStreaming && appMode === "demo" && (
            <div className="message-row agent-row streaming-row">
              <div className="agent-mark live">C</div>
              <div className="bubble agent-bubble">
                <span className="agent-label">
                  CODEX <i>responding</i>
                </span>
                <p>
                  {streamText}
                  <span className="cursor" />
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="composer-area">
          <div className="context-strip">
            <div className="context-item">
              <span className="context-icon">⌘</span>
              <span>
                <small>{appMode === "matrix" ? "Encrypted room" : "Repository"}</small>
                <b>
                  {appMode === "matrix"
                    ? matrixConfig.roomId || "Not connected"
                    : selected.repository}
                </b>
              </span>
            </div>
            <div className="context-item branch-item">
              <span className="branch-mark">⑂</span>
              <code>
                {appMode === "matrix"
                  ? matrixConfig.gatewayId || "Gateway"
                  : selected.branch}
              </code>
            </div>
            <span className="context-spacer" />
            {appMode === "demo" && (
              <span className="token-state">18k / 128k</span>
            )}
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
                    appMode === "matrix"
                      ? "Encrypted attachment upload is not available in this milestone."
                      : "Attach a file in the connected Gateway app."
                  )
                }
              >
                +
              </button>
              <div className="agent-controls">
                <label>
                  <span className="status-spark" />
                  <select
                    value={model}
                    onChange={(event) => void changeModel(event.target.value)}
                    aria-label="Agent model"
                  >
                    <option>GPT-5.2 Codex</option>
                    <option>Claude Sonnet 4</option>
                    <option>Gemini 3 Pro</option>
                    <option>Composer</option>
                  </select>
                </label>
                <span className="control-divider" />
                <label>
                  <select
                    value={mode}
                    onChange={(event) => void changeMode(event.target.value)}
                    aria-label="Agent mode"
                  >
                    <option>Agent</option>
                    <option>Plan</option>
                    <option>Ask</option>
                  </select>
                </label>
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
                  disabled={!draft.trim() || !matrixConnected}
                  aria-label="Send message"
                >
                  ↑
                </button>
              )}
            </div>
          </form>
          <p className="composer-hint">
            {appMode === "matrix"
              ? "Signed locally · Matrix E2EE transport · Enter to send"
              : "Enter to send · Shift + Enter for a new line"}
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
