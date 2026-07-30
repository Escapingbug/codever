"use client";

import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CommandPayload } from "@codever/protocol";
import {
  SENDING_AGENT_ACTIVITY,
  STARTING_AGENT_ACTIVITY,
  STOPPING_AGENT_ACTIVITY,
  WORKING_AGENT_ACTIVITY,
  agentExecutionSignal,
  reduceAgentActivity,
  type AgentActivity,
} from "./agentActivity";
import { MatrixSettings } from "./MatrixSettings";
import {
  NewSessionDialog,
  type NewSessionInput,
} from "./NewSessionDialog";
import { gatewayProjectKey } from "./gatewayState";
import {
  compareChatMessages,
  findOptimisticMessageId,
  mergeChatMessage,
  mergeChatMessages,
  type ChatMessage,
  type OptimisticMessageReference,
} from "./chatMessages";
import {
  clearMessageHistoryScope,
  deleteMessageHistory,
  loadMessageHistoryPage,
  matrixHistoryScope,
  reconcileMessageHistory,
  saveMessageHistory,
  type MessageHistoryCursor,
} from "./messageHistory";
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
  createDeviceInvitationLink,
  decodeDeviceInvitationLink,
  inspectPairingLink,
  loadPendingPairingRecovery,
  loadTrustedGateway,
  pairingLinkFromDeviceInvitation,
  saveTrustedGateway,
  trustedGatewayConfig,
  type GeneratedDeviceInvitation,
  type PairingPreview,
  type TrustedGateway,
} from "./pairing";
import {
  loginWithMatrixPassword,
  loginWithMatrixToken,
  requestMatrixLoginToken,
} from "./matrixAuth";

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
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [stoppingSessionIds, setStoppingSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [agentActivitiesBySession, setAgentActivitiesBySession] = useState<
    Map<string, AgentActivity>
  >(() => new Map());
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
  const [deviceInvitation, setDeviceInvitation] =
    useState<GeneratedDeviceInvitation | null>(null);
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [invitationReauthRequired, setInvitationReauthRequired] =
    useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  const [decisionStates, setDecisionStates] = useState<
    Record<string, "pending" | "submitting" | "approved" | "denied">
  >({});
  const feedRef = useRef<HTMLDivElement>(null);
  const matrixConnectionRef = useRef<MatrixConnection | null>(null);
  const pairingAbortRef = useRef<AbortController | null>(null);
  const pairingRecoveryRef = useRef<
    (
      preview: PairingPreview,
      config: MatrixConnectionConfig,
    ) => Promise<void>
  >(async () => {});
  const revisionConflictRef = useRef<RevisionConflictNotice | null>(null);
  const activePromptCommandsRef = useRef(new Map<string, string>());
  const completedCommandResultsRef = useRef(new Set<string>());
  const optimisticMessagesRef = useRef(
    new Map<string, OptimisticMessageReference>(),
  );
  const reconciledOptimisticMessageIdsRef = useRef(new Set<string>());
  const pendingPromptSessionIdsRef = useRef(new Set<string>());
  const selectedSessionIdRef = useRef<string | null>(null);
  const pendingCreatedSessionIdRef = useRef<string | null>(null);
  const liveMessagesBySessionRef = useRef(new Map<string, ChatMessage[]>());
  const historyScopeRef = useRef("");
  const historySessionIdRef = useRef<string | null>(null);
  const historyCursorRef = useRef<MessageHistoryCursor | null>(null);
  const historyGenerationRef = useRef(0);
  const historyLoadingRef = useRef(false);
  const followLatestRef = useRef(true);
  const prependScrollRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  const selected =
    gatewayState?.sessions.find(
      (session) => session.id === selectedSessionId,
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
  }, [filteredSessions, matrixConfig.gatewayId]);
  const matrixConnected =
    connectionStatus === "connected" || connectionStatus === "reconnecting";
  const isStreaming = Boolean(
    selectedSessionId && runningSessionIds.has(selectedSessionId),
  );
  const isStopping = Boolean(
    selectedSessionId && stoppingSessionIds.has(selectedSessionId),
  );
  const agentActivity = selectedSessionId
    ? agentActivitiesBySession.get(selectedSessionId) ?? null
    : null;
  const sessionReady = Boolean(matrixConnected && gatewayState && selected);
  const conversationTitle =
    selected?.title ??
    (trustedGateway
      ? gatewayState
        ? "No active session"
        : "Syncing Gateway state…"
      : "Add a Gateway");
  const activeProvider =
    selected?.provider ?? gatewayState?.workspace.provider ?? "Gateway agent";
  const activeWorkspace = selected
    ? {
        projectId: selected.projectId,
        projectName: selected.projectName,
        cwd: selected.cwd,
        provider: selected.provider,
        model: selected.model,
        reasoningEffort: selected.reasoningEffort,
        permissionMode: "default",
      }
    : gatewayState?.workspace;
  const activeModelCapability = gatewayState?.capabilities.models.find(
    (model) => model.id === activeWorkspace?.model,
  );

  function setSessionRunning(sessionId: string, running: boolean) {
    setRunningSessionIds((current) => {
      const next = new Set(current);
      if (running) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function setSessionStopping(sessionId: string, stopping: boolean) {
    setStoppingSessionIds((current) => {
      const next = new Set(current);
      if (stopping) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function setSessionAgentActivity(
    sessionId: string,
    update:
      | AgentActivity
      | null
      | ((current: AgentActivity | null) => AgentActivity | null),
  ) {
    setAgentActivitiesBySession((current) => {
      const next = new Map(current);
      const activity =
        typeof update === "function"
          ? update(next.get(sessionId) ?? null)
          : update;
      if (activity) next.set(sessionId, activity);
      else next.delete(sessionId);
      return next;
    });
  }

  function rememberLiveMessage(
    sessionId: string,
    message: ChatMessage,
    options: { reconcileMessageId?: string } = {},
  ) {
    const current = liveMessagesBySessionRef.current.get(sessionId) ?? [];
    const exactIndex = current.findIndex((entry) => entry.id === message.id);
    const next =
      options.reconcileMessageId
        ? mergeChatMessage(current, message, options)
        : exactIndex >= 0
        ? current.map((entry, index) =>
            index === exactIndex ? { ...entry, ...message } : entry,
          )
        : mergeChatMessage(current, message);
    liveMessagesBySessionRef.current.set(sessionId, next.slice(-1_000));
  }

  function removeLiveMessage(sessionId: string, messageId: string) {
    const current = liveMessagesBySessionRef.current.get(sessionId);
    if (!current) return;
    liveMessagesBySessionRef.current.set(
      sessionId,
      current.filter((message) => message.id !== messageId),
    );
  }

  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js").catch(() => {
      // Offline support is opportunistic in local preview environments.
    });
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const link = hash.get("pair");
    const invitation = hash.get("invite");
    const rejectedQueryPairing =
      url.searchParams.has("pair") || url.searchParams.has("invite");
    if (link || invitation || rejectedQueryPairing) {
      hash.delete("pair");
      hash.delete("invite");
      url.searchParams.delete("pair");
      url.searchParams.delete("invite");
      const nextHash = hash.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`,
      );
    }
    if (invitation) void openDeviceInvitation(invitation);
    else if (link) void openPairingLink(link);
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
      if (link || invitation) return;
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
    // URL fragments and persisted pairing recovery are consumed once at boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const prepend = prependScrollRef.current;
    if (prepend) {
      prependScrollRef.current = null;
      feed.scrollTop =
        prepend.scrollTop + (feed.scrollHeight - prepend.scrollHeight);
      return;
    }
    if (followLatestRef.current) {
      feed.scrollTo({
        top: feed.scrollHeight,
        behavior: "auto",
      });
    }
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
    const sessionId =
      incoming.sessionId ?? selectedSessionIdRef.current ?? undefined;
    if (sessionId && !incoming.historical) {
      setSessionAgentActivity(sessionId, (current) =>
        reduceAgentActivity(current, incoming.raw),
      );
      const executionSignal = agentExecutionSignal(incoming.raw);
      if (executionSignal === "running") {
        setSessionRunning(sessionId, true);
      } else if (executionSignal === "stopping") {
        setSessionRunning(sessionId, true);
        setSessionStopping(sessionId, true);
      } else if (executionSignal === "stopped") {
        setSessionRunning(sessionId, false);
        setSessionStopping(sessionId, false);
      }
    }
    const lifecycleFailure = agentLifecycleFailureText(incoming.raw);
    if (
      isTransientAgentLifecycleEvent(incoming.raw) &&
      lifecycleFailure === null
    ) {
      return;
    }
    const displayIncoming: IncomingCodeverMessage =
      lifecycleFailure === null
        ? incoming
        : { ...incoming, kind: "error", text: lifecycleFailure };
    const message = chatMessageFromIncoming(displayIncoming, sessionId);
    const ownUserMessage = Boolean(
      incoming.kind === "user" &&
        incoming.originDeviceId &&
        incoming.originDeviceId === matrixConnectionRef.current?.identity.keyId,
    );
    const optimisticMessageId = ownUserMessage
      ? findOptimisticMessageId(optimisticMessagesRef.current.values(), message)
      : undefined;
    if (optimisticMessageId) {
      reconciledOptimisticMessageIdsRef.current.add(optimisticMessageId);
      optimisticMessagesRef.current.delete(optimisticMessageId);
    }
    if (sessionId && !incoming.historical) {
      rememberLiveMessage(sessionId, message, {
        reconcileMessageId: optimisticMessageId,
      });
    }
    if (sessionId && historyScopeRef.current) {
      const persist =
        message.kind === "user" && message.eventId
          ? reconcileMessageHistory(
              historyScopeRef.current,
              sessionId,
              message,
              optimisticMessageId,
            )
          : saveMessageHistory(historyScopeRef.current, sessionId, [message]);
      void persist.catch((error) => {
        setConnectionError(
          `Conversation history could not be saved: ${formatUiError(error)}`,
        );
      });
    }
    if (
      sessionId &&
      sessionId !== selectedSessionIdRef.current
    ) {
      return;
    }
    if (incoming.requestId && !incoming.historical) {
      setDecisionStates((current) => ({
        ...current,
        [incoming.eventId]: "pending",
      }));
    }
    const feed = feedRef.current;
    followLatestRef.current = !feed || isNearFeedBottom(feed);
    setMessages((current) =>
      mergeChatMessage(current, message, {
        reconcileMessageId: optimisticMessageId,
      }),
    );
  }

  async function restoreSessionHistory(
    sessionId: string,
    connection: MatrixConnection | null = matrixConnectionRef.current,
  ): Promise<void> {
    const scope = historyScopeRef.current;
    if (!scope) return;
    const generation = ++historyGenerationRef.current;
    historySessionIdRef.current = sessionId;
    historyCursorRef.current = null;
    followLatestRef.current = true;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryHasMore(false);
    setMessages([]);
    setDecisionStates({});
    try {
      const cached = await loadMessageHistoryPage(scope, sessionId);
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      const cachedMessages = cached.messages.map((message) => ({
        ...message,
        sessionId,
        historical: true,
        ...(message.deliveryState === "sending"
          ? { deliveryState: "failed" as const }
          : {}),
      }));
      const interruptedSends = cached.messages
        .filter((message) => message.deliveryState === "sending")
        .map((message) => ({
          ...message,
          deliveryState: "failed" as const,
        }));
      if (interruptedSends.length > 0) {
        await saveMessageHistory(
          scope,
          sessionId,
          interruptedSends,
        );
        if (
          generation !== historyGenerationRef.current ||
          historySessionIdRef.current !== sessionId
        ) {
          return;
        }
      }
      const liveMessages =
        liveMessagesBySessionRef.current.get(sessionId) ?? [];
      historyCursorRef.current = cached.cursor;
      setMessages((current) =>
        mergeChatMessages(current, [...liveMessages, ...cachedMessages]),
      );
      setHistoryHasMore(cached.hasMore || Boolean(connection));

      if (!connection) return;
      connection.markHistoryLoaded(
        sessionId,
        cachedMessages.flatMap((message) =>
          message.eventId ? [message.eventId] : [],
        ),
      );
      // Even with a local first page, reconcile once against Matrix's recent
      // timeline. Older PWA versions persisted local optimistic timestamps and
      // discarded the authoritative user echo, so cache-only restoration can
      // preserve the wrong user/agent order indefinitely.
      const remote =
        cachedMessages.length > 0
          ? await connection.loadRecentHistory(sessionId)
          : await connection.loadHistoryPage(sessionId);
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      const remoteMessages = remote.messages.map((incoming) =>
        chatMessageFromIncoming(
          { ...incoming, historical: true },
          incoming.sessionId ?? sessionId,
        ),
      );
      if (remoteMessages.length > 0) {
        await persistMessageHistoryPage(scope, sessionId, remoteMessages);
        historyCursorRef.current = olderHistoryCursor(
          historyCursorRef.current,
          remoteMessages,
        );
        setMessages((current) =>
          mergeChatMessages(current, remoteMessages),
        );
      }
      setHistoryHasMore(cached.hasMore || remote.hasMore);
    } catch (error) {
      setConnectionError(
        `Conversation history could not be restored: ${formatUiError(error)}`,
      );
    } finally {
      if (generation === historyGenerationRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }

  async function loadOlderHistory(): Promise<void> {
    const sessionId = historySessionIdRef.current;
    const scope = historyScopeRef.current;
    if (
      !sessionId ||
      !scope ||
      historyLoadingRef.current ||
      !historyHasMore
    ) {
      return;
    }
    const generation = historyGenerationRef.current;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    try {
      const cached = await loadMessageHistoryPage(scope, sessionId, {
        before: historyCursorRef.current,
      });
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      if (cached.messages.length > 0) {
        const olderMessages = cached.messages.map((message) => ({
          ...message,
          sessionId,
          historical: true,
        }));
        prepareHistoryPrepend(feedRef.current, prependScrollRef);
        historyCursorRef.current = cached.cursor;
        setMessages((current) =>
          mergeChatMessages(current, olderMessages),
        );
        // Consume at most one local page per pull. Once the local cache ends,
        // advance Matrix by one page in parallel so a later pull does not need
        // to replay every already-cached server page after a refresh.
        const connection = matrixConnectionRef.current;
        if (!connection) {
          setHistoryHasMore(cached.hasMore);
          return;
        }
        connection.markHistoryLoaded(
          sessionId,
          olderMessages.flatMap((message) =>
            message.eventId ? [message.eventId] : [],
          ),
        );
        const prefetched = await connection.loadHistoryPage(sessionId);
        if (
          generation !== historyGenerationRef.current ||
          historySessionIdRef.current !== sessionId
        ) {
          return;
        }
        const prefetchedMessages = prefetched.messages.map((incoming) =>
          chatMessageFromIncoming(
            { ...incoming, historical: true },
            incoming.sessionId ?? sessionId,
          ),
        );
        if (prefetchedMessages.length > 0) {
          await persistMessageHistoryPage(
            scope,
            sessionId,
            prefetchedMessages,
          );
        }
        setHistoryHasMore(cached.hasMore || prefetched.hasMore);
        return;
      }

      const connection = matrixConnectionRef.current;
      if (!connection) {
        setHistoryHasMore(false);
        return;
      }
      const remote = await connection.loadHistoryPage(sessionId);
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      const olderMessages = remote.messages.map((incoming) =>
        chatMessageFromIncoming(
          { ...incoming, historical: true },
          incoming.sessionId ?? sessionId,
        ),
      );
      if (olderMessages.length > 0) {
        await persistMessageHistoryPage(scope, sessionId, olderMessages);
        prepareHistoryPrepend(feedRef.current, prependScrollRef);
        historyCursorRef.current = olderHistoryCursor(
          historyCursorRef.current,
          olderMessages,
        );
        setMessages((current) =>
          mergeChatMessages(current, olderMessages),
        );
      }
      setHistoryHasMore(remote.hasMore);
    } catch (error) {
      setConnectionError(
        `Older history could not be loaded: ${formatUiError(error)}`,
      );
    } finally {
      if (generation === historyGenerationRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }

  function handleFeedScroll() {
    const feed = feedRef.current;
    if (!feed) return;
    followLatestRef.current = isNearFeedBottom(feed);
    if (
      feed.scrollTop <= 80 &&
      historyHasMore &&
      !historyLoadingRef.current
    ) {
      void loadOlderHistory();
    }
  }

  function activateLocalSession(
    sessionId: string | null,
    connection: MatrixConnection | null = matrixConnectionRef.current,
  ) {
    const sessionChanged = selectedSessionIdRef.current !== sessionId;
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    if (!sessionChanged) return;
    historyGenerationRef.current += 1;
    historySessionIdRef.current = sessionId;
    historyCursorRef.current = null;
    setMessages([]);
    setDecisionStates({});
    setHistoryHasMore(Boolean(sessionId));
    if (!sessionId) {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    } else if (connection) {
      void restoreSessionHistory(sessionId, connection);
    }
  }

  async function connectRealMatrix(
    configInput = matrixConfig,
    closeSettings = true,
  ): Promise<MatrixConnection | null> {
    matrixConnectionRef.current?.stop();
    matrixConnectionRef.current = null;
    optimisticMessagesRef.current.clear();
    reconciledOptimisticMessageIdsRef.current.clear();
    pendingPromptSessionIdsRef.current.clear();
    revisionConflictRef.current = null;
    activePromptCommandsRef.current.clear();
    completedCommandResultsRef.current.clear();
    setRevisionConflict(null);
    setConnectionError(null);
    setConnectionStatus("connecting");
    setMessages([]);
    setSelectedSessionId(null);
    setRunningSessionIds(new Set());
    setStoppingSessionIds(new Set());
    setAgentActivitiesBySession(new Map());
    pendingCreatedSessionIdRef.current = null;
    liveMessagesBySessionRef.current.clear();
    setGatewayState(null);
    setGatewayRevision(null);
    selectedSessionIdRef.current = null;
    historySessionIdRef.current = null;
    historyCursorRef.current = null;
    historyGenerationRef.current += 1;
    historyLoadingRef.current = false;
    setHistoryLoading(false);
    setHistoryHasMore(false);
    try {
      const normalized = normalizeMatrixConfig(configInput);
      historyScopeRef.current = matrixHistoryScope({
        gatewayId: normalized.gatewayId,
        conversationId: normalized.conversationId,
        roomId: normalized.roomId,
      });
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
            setGatewayState(state.gatewayState);
            const runningIds = new Set(
              state.gatewayState.sessions
                .filter(
                  (session) =>
                    session.status === "running" ||
                    session.status === "stopping",
                )
                .map((session) => session.id),
            );
            const stoppingIds = new Set(
              state.gatewayState.sessions
                .filter((session) => session.status === "stopping")
                .map((session) => session.id),
            );
            setRunningSessionIds(runningIds);
            setStoppingSessionIds(stoppingIds);
            setAgentActivitiesBySession((current) => {
              const next = new Map<string, AgentActivity>();
              for (const session of state.gatewayState!.sessions) {
                if (session.status === "stopping") {
                  next.set(session.id, STOPPING_AGENT_ACTIVITY);
                } else if (session.status === "running") {
                  next.set(
                    session.id,
                    current.get(session.id) ?? WORKING_AGENT_ACTIVITY,
                  );
                }
              }
              return next;
            });
            const availableIds = new Set(
              state.gatewayState.sessions.map((session) => session.id),
            );
            const pendingCreated = pendingCreatedSessionIdRef.current;
            const nextSessionId =
              pendingCreated && availableIds.has(pendingCreated)
                ? pendingCreated
                : selectedSessionIdRef.current &&
                    availableIds.has(selectedSessionIdRef.current)
                  ? selectedSessionIdRef.current
                  : state.gatewayState.currentSessionId &&
                      availableIds.has(state.gatewayState.currentSessionId)
                    ? state.gatewayState.currentSessionId
                    : state.gatewayState.sessions[0]?.id ?? null;
            if (pendingCreated === nextSessionId) {
              pendingCreatedSessionIdRef.current = null;
            }
            activateLocalSession(nextSessionId);
          }
        },
        onCommandResult(result) {
          const promptSessionId =
            activePromptCommandsRef.current.get(result.commandId);
          if (promptSessionId) {
            activePromptCommandsRef.current.delete(result.commandId);
            completedCommandResultsRef.current.delete(result.commandId);
            setSessionRunning(promptSessionId, false);
            setSessionStopping(promptSessionId, false);
            setSessionAgentActivity(promptSessionId, null);
          } else {
            completedCommandResultsRef.current.add(result.commandId);
          }
        },
      });
      matrixConnectionRef.current = connection;
      setDeviceKeyId(connection.identity.keyId);
      if (closeSettings) setSettingsOpen(false);
      if (selectedSessionIdRef.current) {
        await restoreSessionHistory(
          selectedSessionIdRef.current,
          connection,
        );
      }
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
    optimisticMessagesRef.current.clear();
    reconciledOptimisticMessageIdsRef.current.clear();
    pendingPromptSessionIdsRef.current.clear();
    revisionConflictRef.current = null;
    activePromptCommandsRef.current.clear();
    completedCommandResultsRef.current.clear();
    pendingCreatedSessionIdRef.current = null;
    liveMessagesBySessionRef.current.clear();
    setRevisionConflict(null);
    setConnectionStatus("offline");
    setRunningSessionIds(new Set());
    setStoppingSessionIds(new Set());
    setAgentActivitiesBySession(new Map());
    setSelectedSessionId(null);
    setGatewayState(null);
    setGatewayRevision(null);
    selectedSessionIdRef.current = null;
    historyGenerationRef.current += 1;
    historySessionIdRef.current = null;
    historyCursorRef.current = null;
    historyLoadingRef.current = false;
    setHistoryLoading(false);
    setHistoryHasMore(false);
  }

  function forgetMatrixConfig() {
    const historyScope = historyScopeRef.current;
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
    selectedSessionIdRef.current = null;
    setPairingPreview(null);
    setDeviceInvitation(null);
    setInvitationReauthRequired(false);
    setConnectionError(null);
    setMessages([]);
    historyScopeRef.current = "";
    if (historyScope) {
      void clearMessageHistoryScope(historyScope).catch((error) => {
        setConnectionError(
          `Conversation history could not be cleared: ${formatUiError(error)}`,
        );
      });
    }
    setSettingsOpen(true);
  }

  async function openPairingLink(link: string) {
    setConnectionError(null);
    try {
      if (deviceInvitationFromLink(link)) {
        await openDeviceInvitation(link);
        return;
      }
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

  async function openDeviceInvitation(link: string) {
    setConnectionError(null);
    try {
      const invitation = decodeDeviceInvitationLink(link);
      const preview = await inspectPairingLink(
        pairingLinkFromDeviceInvitation(invitation),
      );
      const transport = preview.transport;
      let nextConfig: MatrixConnectionConfig = {
        ...bindCredentialsToHomeserver(matrixConfig, transport.homeserver),
        roomId: transport.roomId,
        gatewayId: preview.gatewayId,
        conversationId: transport.roomId,
        gatewayMatrixUserId: transport.userId,
        gatewayMatrixDeviceId: transport.deviceId,
        gatewayMatrixEd25519: transport.ed25519,
        ...(invitation.matrixLogin
          ? { userId: invitation.matrixLogin.userId }
          : {}),
      };
      setPairingPreview(preview);
      setMatrixConfig(nextConfig);
      setSettingsOpen(true);

      const matrixLogin = invitation.matrixLogin;
      if (!matrixLogin) return;
      if (matrixLogin.expiresAt <= Date.now()) {
        setConnectionError(
          "The one-time Matrix login expired. Sign in with your Matrix ID and password below; the Gateway invitation may still be valid.",
        );
        return;
      }
      try {
        const credentials = await loginWithMatrixToken(
          matrixLogin.homeserver,
          matrixLogin.loginToken,
          matrixLogin.userId,
          browserDeviceName(),
        );
        nextConfig = { ...nextConfig, ...credentials };
        setMatrixConfig(nextConfig);
        saveMatrixConfig(nextConfig);
      } catch (error) {
        setConnectionError(
          `The one-time Matrix sign-in could not be used: ${formatUiError(error)} Sign in below to continue.`,
        );
      }
    } catch (error) {
      setConnectionError(formatUiError(error));
      setSettingsOpen(true);
    }
  }

  async function signInForPairing(userId: string, password: string) {
    if (pairingBusy) return;
    setPairingBusy(true);
    setConnectionError(null);
    try {
      const credentials = await loginWithMatrixPassword(
        matrixConfig.homeserver,
        userId,
        password,
        browserDeviceName(),
      );
      const next = { ...matrixConfig, ...credentials };
      setMatrixConfig(next);
      saveMatrixConfig(next);
    } catch (error) {
      setConnectionError(formatUiError(error));
    } finally {
      setPairingBusy(false);
    }
  }

  async function createDeviceInvitation(password?: string) {
    if (invitationBusy) return;
    if (!trustedGateway || !matrixConnectionRef.current) {
      setConnectionError(
        "Connect to the trusted Gateway before authorizing another device.",
      );
      return;
    }
    setInvitationBusy(true);
    setConnectionError(null);
    try {
      const tokenResult = await requestMatrixLoginToken(
        matrixConfig,
        password,
      );
      if (
        tokenResult.status === "reauth-required" &&
        tokenResult.passwordSupported
      ) {
        setInvitationReauthRequired(true);
        return;
      }

      const sent = await sendRealCommand({
        operation: "device.invite",
        lifetimeMs: 5 * 60_000,
      });
      if (!sent) return;
      const completion = await sent.completion;
      if (completion.outcome !== "succeeded") {
        throw new Error("The Gateway could not create the device invitation.");
      }
      const gatewayInvitation = parseGatewayInvitationResult(
        completion.result,
      );
      const generated = createDeviceInvitationLink({
        pairingLink: gatewayInvitation.pairingLink,
        appUrl: window.location.href,
        ...(tokenResult.status === "ready"
          ? {
              matrixLogin: {
                homeserver: matrixConfig.homeserver,
                userId: matrixConfig.userId,
                loginToken: tokenResult.loginToken,
                expiresAt: tokenResult.expiresAt,
              },
            }
          : {}),
      });
      setDeviceInvitation(generated);
      setInvitationReauthRequired(false);
    } catch (error) {
      setConnectionError(formatUiError(error));
    } finally {
      setInvitationBusy(false);
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
    const conflictSessionId =
      conflict.payload.operation === "session.create" ||
      conflict.payload.operation === "device.invite"
        ? undefined
        : conflict.payload.sessionId;
    const optimisticMessage = conflict.optimisticMessageId
      ? [
          ...messages,
          ...(conflictSessionId
            ? liveMessagesBySessionRef.current.get(conflictSessionId) ?? []
            : []),
        ].find((message) => message.id === conflict.optimisticMessageId)
      : undefined;
    const busyConflict = { ...conflict, busy: true };
    revisionConflictRef.current = busyConflict;
    setRevisionConflict(busyConflict);
    try {
      const result = await connection.confirmRevisionRetry(conflict.commandId);
      setGatewayRevision((current) =>
        current === null ? result.revision : Math.max(current, result.revision),
      );
      if (
        conflict.optimisticMessageId &&
        optimisticMessage &&
        conflictSessionId
      ) {
        const sentMessage: ChatMessage = {
          ...optimisticMessage,
          commandId: result.commandId,
          revision: result.revision,
          optimistic: true,
          deliveryState: "sent",
        };
        const optimisticReference = optimisticMessagesRef.current.get(
          conflict.optimisticMessageId,
        );
        if (optimisticReference) {
          optimisticReference.commandId = result.commandId;
        }
        if (selectedSessionIdRef.current === conflictSessionId) {
          setMessages((current) =>
            current.map((message) =>
              message.id === conflict.optimisticMessageId
                ? sentMessage
                : message,
            ),
          );
        }
        rememberLiveMessage(conflictSessionId, sentMessage);
        if (historyScopeRef.current) {
          void saveMessageHistory(
            historyScopeRef.current,
            conflictSessionId,
            [sentMessage],
          ).catch((error) => {
            setConnectionError(
              `Conversation history could not be saved: ${formatUiError(error)}`,
            );
          });
        }
      }
      if (conflict.payload.operation === "prompt") {
        const sessionId = conflict.payload.sessionId;
        if (completedCommandResultsRef.current.delete(result.commandId)) {
          setSessionRunning(sessionId, false);
          setSessionAgentActivity(sessionId, null);
        } else {
          activePromptCommandsRef.current.set(result.commandId, sessionId);
          setSessionRunning(sessionId, true);
          setSessionAgentActivity(sessionId, STARTING_AGENT_ACTIVITY);
        }
      }
      const completion =
        conflict.payload.operation === "prompt"
          ? null
          : await result.completion;
      if (
        completion?.outcome === "succeeded" &&
        conflict.payload.operation === "cancel"
      ) {
        setSessionRunning(conflict.payload.sessionId, false);
        setSessionStopping(conflict.payload.sessionId, false);
        setSessionAgentActivity(conflict.payload.sessionId, null);
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
      if (revisionConflictRef.current?.commandId === conflict.commandId) {
        revisionConflictRef.current = null;
        setRevisionConflict(null);
      }
    } catch (error) {
      if (conflict.payload.operation === "prompt") {
        setSessionRunning(conflict.payload.sessionId, false);
        setSessionAgentActivity(conflict.payload.sessionId, null);
      }
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
        optimisticMessagesRef.current.delete(conflict.optimisticMessageId);
        reconciledOptimisticMessageIdsRef.current.delete(
          conflict.optimisticMessageId,
        );
        if (
          conflict.payload.operation !== "session.create" &&
          conflict.payload.operation !== "device.invite"
        ) {
          removeLiveMessage(
            conflict.payload.sessionId,
            conflict.optimisticMessageId,
          );
        }
        setMessages((current) =>
          current.filter(
            (message) => message.id !== conflict.optimisticMessageId,
          ),
        );
        if (historyScopeRef.current) {
          await deleteMessageHistory(
            historyScopeRef.current,
            conflict.optimisticMessageId,
          );
        }
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
    setMobileChatOpen(true);
    activateLocalSession(id);
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
      const completion = sent ? await sent.completion : null;
      if (completion?.outcome === "succeeded") {
        if (completion.sessionId) {
          pendingCreatedSessionIdRef.current = completion.sessionId;
        }
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
    if (!value) return;
    const sessionId = selectedSessionIdRef.current;
    if (
      isStreaming ||
      (sessionId && pendingPromptSessionIdsRef.current.has(sessionId))
    ) {
      return;
    }
    if (!matrixConnected || !gatewayState || !sessionId) {
      setConnectionError(
        !gatewayState && matrixConnected
          ? "Waiting for the current Gateway session state."
          : gatewayState && !sessionId
          ? "Create or select a session before sending a message."
          : trustedGateway
          ? "The Gateway is offline. Reconnect before sending."
          : "Add and pair a Gateway before sending your first message.",
      );
      setSettingsOpen(true);
      return;
    }
    const submissionHistoryScope = historyScopeRef.current;
    const submissionOriginDeviceId = deviceKeyId ?? undefined;
    const submissionOriginDeviceName =
      trustedGateway?.certificate.certificate.deviceName;
    const optimisticId = `user-${Date.now()}-${crypto.randomUUID()}`;
    const optimisticMessage: ChatMessage = {
      id: optimisticId,
      kind: "user",
      text: value,
      time: "now",
      timestamp: Date.now(),
      sessionId,
      optimistic: true,
      deliveryState: "sending",
    };
    optimisticMessagesRef.current.set(optimisticId, {
      id: optimisticId,
      text: value,
      sessionId: optimisticMessage.sessionId,
    });
    rememberLiveMessage(sessionId, optimisticMessage);
    followLatestRef.current = true;
    setMessages((current) => [
      ...current,
      optimisticMessage,
    ]);
    if (submissionHistoryScope) {
      void saveMessageHistory(
        submissionHistoryScope,
        sessionId,
        [optimisticMessage],
      ).catch((error) => {
        setConnectionError(
          `Conversation history could not be saved: ${formatUiError(error)}`,
        );
      });
    }
    setDraft("");
    setSessionRunning(sessionId, true);
    setSessionAgentActivity(sessionId, SENDING_AGENT_ACTIVITY);
    pendingPromptSessionIdsRef.current.add(sessionId);
    const result = await sendRealCommand({
      operation: "prompt",
      sessionId,
      text: value,
    });
    pendingPromptSessionIdsRef.current.delete(sessionId);
    if (!result) {
      setSessionRunning(sessionId, false);
      setSessionAgentActivity(sessionId, null);
      if (revisionConflictRef.current) {
        const conflict = revisionConflictRef.current;
        const matchesCurrentPrompt =
          conflict.payload.operation === "prompt" &&
          conflict.payload.sessionId === sessionId &&
          conflict.payload.text === value;
        const next = matchesCurrentPrompt
          ? { ...conflict, optimisticMessageId: optimisticId }
          : conflict;
        revisionConflictRef.current = next;
        setRevisionConflict(next);
        if (!matchesCurrentPrompt) {
          optimisticMessagesRef.current.delete(optimisticId);
          removeLiveMessage(sessionId, optimisticId);
          if (selectedSessionIdRef.current === sessionId) {
            setMessages((current) =>
              current.filter((message) => message.id !== optimisticId),
            );
          }
          if (submissionHistoryScope) {
            void deleteMessageHistory(
              submissionHistoryScope,
              optimisticId,
            ).catch((error) => {
              setConnectionError(
                `Conversation history could not be updated: ${formatUiError(error)}`,
              );
            });
          }
          if (selectedSessionIdRef.current === sessionId) {
            setDraft(value);
          }
        }
      } else {
        optimisticMessagesRef.current.delete(optimisticId);
        const failedMessage: ChatMessage = {
          ...optimisticMessage,
          optimistic: false,
          deliveryState: "failed",
        };
        rememberLiveMessage(sessionId, failedMessage);
        if (selectedSessionIdRef.current === sessionId) {
          setMessages((current) =>
            current.map((message) =>
              message.id === optimisticId
                ? failedMessage
              : message,
            ),
          );
        }
        if (submissionHistoryScope) {
          void saveMessageHistory(
            submissionHistoryScope,
            sessionId,
            [failedMessage],
          ).catch((error) => {
            setConnectionError(
              `Conversation history could not be saved: ${formatUiError(error)}`,
            );
          });
        }
        const errorMessage: ChatMessage = {
          id: `matrix-error-${Date.now()}`,
          kind: "error",
          text: "The signed command was not sent. Check Matrix connection settings.",
          time: "now",
          timestamp: Date.now(),
          sessionId,
        };
        rememberLiveMessage(sessionId, errorMessage);
        if (selectedSessionIdRef.current === sessionId) {
          setMessages((current) => [
            ...current,
            errorMessage,
          ]);
        }
      }
    } else {
      const optimisticReference =
        optimisticMessagesRef.current.get(optimisticId);
      if (optimisticReference) {
        optimisticReference.commandId = result.commandId;
      }
      if (completedCommandResultsRef.current.delete(result.commandId)) {
        setSessionRunning(sessionId, false);
        setSessionAgentActivity(sessionId, null);
      } else {
        activePromptCommandsRef.current.set(result.commandId, sessionId);
        setSessionAgentActivity(sessionId, STARTING_AGENT_ACTIVITY);
      }
      const sentMessage: ChatMessage = {
        ...optimisticMessage,
        commandId: result.commandId,
        revision: result.revision,
        originDeviceId: submissionOriginDeviceId,
        originDeviceName: submissionOriginDeviceName,
        deliveryState: "sent",
      };
      const wasAlreadyReconciled =
        reconciledOptimisticMessageIdsRef.current.delete(optimisticId);
      if (
        !wasAlreadyReconciled &&
        selectedSessionIdRef.current === sessionId
      ) {
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId ? sentMessage : message,
          ),
        );
      }
      if (!wasAlreadyReconciled) {
        rememberLiveMessage(sessionId, sentMessage);
      }
      if (!wasAlreadyReconciled && submissionHistoryScope) {
        void saveMessageHistory(
          submissionHistoryScope,
          sessionId,
          [sentMessage],
        ).catch((error) => {
          setConnectionError(
            `Conversation history could not be saved: ${formatUiError(error)}`,
          );
        });
      }
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function stopStreaming() {
    if (isStopping) return;
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId) return;
    setSessionStopping(sessionId, true);
    setSessionAgentActivity(sessionId, STOPPING_AGENT_ACTIVITY);
    const sent = await sendRealCommand({ operation: "cancel", sessionId });
    if (!sent || (await sent.completion).outcome !== "succeeded") {
      setSessionStopping(sessionId, false);
      setSessionAgentActivity(
        sessionId,
        runningSessionIds.has(sessionId) ? WORKING_AGENT_ACTIVITY : null,
      );
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
    const sessionId = message.sessionId ?? selectedSessionIdRef.current;
    if (!sessionId) {
      setConnectionError("This permission request has no session identity.");
      return;
    }
    setDecisionStates((current) => ({
      ...current,
      [message.id]: "submitting",
    }));
    const sent = await sendRealCommand({
      operation: "decision",
      sessionId,
      requestId: message.requestId,
      decision,
    });
    if (sent && (await sent.completion).outcome === "succeeded") {
      setDecisionStates((current) => ({
        ...current,
        [message.id]: decision === "allow_once" ? "approved" : "denied",
      }));
    } else {
      setDecisionStates((current) => ({
        ...current,
        [message.id]: "pending",
      }));
    }
  }

  async function changeModel(nextModel: string) {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId) return;
    const sent = await sendRealCommand({
      operation: "session.settings",
      sessionId,
      model: nextModel,
    });
    if (sent) await sent.completion;
  }

  async function changeReasoningEffort(nextReasoningEffort: string) {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId) return;
    const sent = await sendRealCommand({
      operation: "session.settings",
      sessionId,
      reasoningEffort: nextReasoningEffort,
    });
    if (sent) await sent.completion;
  }

  async function changeMode(nextMode: string) {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId) return;
    const sent = await sendRealCommand({
      operation: "session.settings",
      sessionId,
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
          className={`gateway-card gateway-card-button connection-state-${connectionStatus} ${
            connectionStatus === "offline" || connectionStatus === "error"
              ? "offline"
              : ""
          }`}
          onClick={() => setSettingsOpen(true)}
        >
          <span className="gateway-icon">G</span>
          <div>
            <strong>
              {trustedGateway?.gatewayName || "Add a Gateway"}
            </strong>
            <span>
              <i
                className={`connection-dot connection-state-${connectionStatus}`}
              />{" "}
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
                    selectedSessionId === session.id
                      ? "selected"
                      : ""
                  }`}
                  onClick={() => void chooseSession(session.id)}
                >
                  <span className="session-avatar violet">
                    {sessionInitials(session.title)}
                    {matrixConnected &&
                      runningSessionIds.has(session.id) && (
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
              <i
                className={`connection-dot connection-state-${connectionStatus} ${
                  connectionStatus === "offline" || connectionStatus === "error"
                    ? "offline-dot"
                    : ""
                }`}
              />{" "}
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
              {activeWorkspace?.projectName || "Syncing…"}
            </strong>
            <code>{activeWorkspace?.cwd || "Syncing…"}</code>
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
          onScroll={handleFeedScroll}
        >
          <div
            className={`history-loader ${historyLoading ? "is-loading" : ""}`}
            aria-live="polite"
          >
            {historyLoading ? (
              <span>Loading earlier messages…</span>
            ) : historyHasMore ? (
              <button type="button" onClick={() => void loadOlderHistory()}>
                Load earlier messages
              </button>
            ) : messages.length > 0 ? (
              <span>Beginning of loaded history</span>
            ) : null}
          </div>
          <div className="date-divider">
            <span>Recent messages</span>
          </div>
          {historyLoading && messages.length === 0 && (
            <div className="history-skeleton" aria-hidden="true" />
          )}
          {messages.map((message) => {
            if (message.kind === "notice") {
              return (
                <div
                  className={`encryption-notice ${
                    message.historical ? "" : "notice-enter"
                  }`}
                  key={message.id}
                >
                  <span className="shield">✓</span>
                  <span>{message.text}</span>
                </div>
              );
            }
            if (message.kind === "error") {
              return (
                <div
                  className={`message-row agent-row ${
                    message.historical ? "" : "message-enter"
                  }`}
                  key={message.id}
                >
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
              const deliveryState =
                message.deliveryState ??
                (message.revision !== undefined ? "sent" : undefined);
              return (
                <div
                  className={`message-row user-row ${
                    message.historical ? "" : "message-enter"
                  }`}
                  key={message.id}
                >
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
                      {deliveryState && (
                        <span
                          className={`delivery-indicator ${deliveryState}`}
                          aria-label={
                            deliveryState === "sending"
                              ? "Sending"
                              : deliveryState === "failed"
                                ? "Send failed"
                                : "Sent"
                          }
                        >
                          {deliveryState === "sending"
                            ? "…"
                            : deliveryState === "failed"
                              ? "!"
                              : "✓✓"}
                        </span>
                      )}
                    </time>
                  </div>
                </div>
              );
            }
            if (message.kind === "tool") {
              const toolStatus = message.toolStatus ?? "succeeded";
              return (
                <div
                  className={`message-row agent-row ${
                    message.historical ? "" : "message-enter"
                  }`}
                  key={message.id}
                >
                  <div
                    className={`agent-mark ${
                      toolStatus === "running" ? "live" : ""
                    }`}
                  >
                    C
                  </div>
                  <div className={`tool-card ${toolStatus}`}>
                    <div className="tool-heading">
                      <span className="terminal-mark">&gt;_</span>
                      <span>
                        <strong>{message.text || "Agent tool"}</strong>
                        <small>
                          {toolStatus === "running"
                            ? "Agent is using this tool"
                            : toolStatus === "failed"
                              ? "Tool failed"
                              : "Tool completed"}
                        </small>
                      </span>
                      <b
                        className="tool-status-icon"
                        aria-label={
                          toolStatus === "running"
                            ? "Tool running"
                            : toolStatus === "failed"
                              ? "Tool failed"
                              : "Tool completed"
                        }
                      >
                        {toolStatus === "running"
                          ? ""
                          : toolStatus === "failed"
                            ? "×"
                            : "✓"}
                      </b>
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
                <div
                  className={`message-row agent-row ${
                    message.historical ? "" : "message-enter"
                  }`}
                  key={message.id}
                >
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
                    {message.historical ? (
                      <div className="decision-state historical">
                        History only · request not replayed
                      </div>
                    ) : decisionState === "submitting" ? (
                      <div className="decision-state submitting">
                        Signing response…
                      </div>
                    ) : decisionState === "pending" ? (
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
              <div
                className={`message-row agent-row ${
                  message.historical ? "" : "message-enter"
                }`}
                key={message.id}
              >
                <div
                  className={`agent-mark ${
                    message.raw?.type === "agent.text.delta" ? "live" : ""
                  }`}
                >
                  C
                </div>
                <div className="bubble agent-bubble">
                  <span className="agent-label">CODEX</span>
                  <p>
                    {message.text}
                    {message.raw?.type === "agent.text.delta" && (
                      <span className="cursor" aria-hidden="true" />
                    )}
                  </p>
                  <time>{message.time}</time>
                </div>
              </div>
            );
          })}
          {agentActivity && (
            <div
              className={`agent-activity activity-${agentActivity.phase}`}
              key={`${agentActivity.phase}:${agentActivity.label}:${agentActivity.detail ?? ""}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="activity-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>
                <strong>{agentActivity.label}</strong>
                {agentActivity.detail && <small>{agentActivity.detail}</small>}
              </span>
            </div>
          )}
        </div>

        <div className="composer-area">
          <div className="context-strip">
            <div className="context-item">
              <span className="context-icon">⌘</span>
              <span>
                <small>Project · Gateway</small>
                <b title={activeWorkspace?.cwd}>
                  {activeWorkspace?.projectName || "Syncing Gateway state…"}
                  {trustedGateway ? ` · ${trustedGateway.gatewayName}` : ""}
                </b>
              </span>
            </div>
            <div className="context-item branch-item">
              <span className="branch-mark">⑂</span>
              <code>{activeWorkspace?.provider || "Gateway"}</code>
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
                  key="stop-agent"
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
                    value={activeWorkspace?.model ?? ""}
                    onChange={(event) => void changeModel(event.target.value)}
                    aria-label="Agent model"
                    disabled={
                      !sessionReady ||
                      gatewayState!.capabilities.models.length === 0
                    }
                  >
                    {!activeWorkspace?.model && (
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
                      activeWorkspace?.reasoningEffort ??
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
                        value={activeWorkspace?.permissionMode ?? ""}
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
                  className="send-button stop-button mount-feedback"
                  onClick={() => void stopStreaming()}
                  aria-label={isStopping ? "Stopping agent" : "Stop agent"}
                  aria-busy={isStopping}
                  disabled={isStopping}
                >
                  {isStopping ? <span className="button-spinner" /> : "■"}
                </button>
              ) : (
                <button
                  key="send-message"
                  type="submit"
                  className="send-button mount-feedback"
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
        deviceInvitation={deviceInvitation}
        invitationBusy={invitationBusy}
        invitationReauthRequired={invitationReauthRequired}
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
        onPasswordLogin={(userId, password) =>
          void signInForPairing(userId, password)
        }
        onCreateInvitation={(password) =>
          void createDeviceInvitation(password)
        }
        onClearInvitation={() => {
          setDeviceInvitation(null);
          setInvitationReauthRequired(false);
          setConnectionError(null);
        }}
      />
    </main>
  );
}

function isTransientAgentLifecycleEvent(
  raw: Record<string, unknown>,
): boolean {
  return (
    raw.kind === "status" ||
    raw.type === "command.accepted" ||
    raw.type === "command.completed" ||
    raw.type === "session.updated"
  );
}

function agentLifecycleFailureText(
  raw: Record<string, unknown>,
): string | null {
  if (
    raw.type === "command.completed" &&
    raw.outcome === "failed"
  ) {
    return typeof raw.error === "string" && raw.error.trim()
      ? raw.error
      : "The command could not be completed.";
  }
  if (
    (raw.type === "session.updated" && raw.status === "failed") ||
    (raw.kind === "status" && raw.state === "failed")
  ) {
    return typeof raw.error === "string" && raw.error.trim()
      ? raw.error
      : "The agent session failed.";
  }
  return null;
}

function chatMessageFromIncoming(
  incoming: IncomingCodeverMessage,
  sessionId?: string,
): ChatMessage {
  return {
    id: incoming.eventId,
    eventId: incoming.eventId,
    kind: incoming.kind === "error" ? "error" : incoming.kind,
    text: incoming.text,
    time: formatMessageTime(incoming.timestamp),
    timestamp: incoming.timestamp,
    requestId: incoming.requestId,
    streamId: incoming.streamId,
    toolCallId: incoming.toolCallId,
    toolStatus: incoming.toolStatus,
    replacesEventId: incoming.replacesEventId,
    commandId: incoming.commandId,
    revision: incoming.revision,
    originDeviceId: incoming.originDeviceId,
    originDeviceName: incoming.originDeviceName,
    sessionId,
    historical: incoming.historical,
    raw: incoming.raw,
  };
}

async function persistMessageHistoryPage(
  scope: string,
  sessionId: string,
  messages: readonly ChatMessage[],
): Promise<void> {
  const canonicalUsers = messages.filter(
    (message) => message.kind === "user" && message.eventId,
  );
  const remaining = messages.filter(
    (message) => message.kind !== "user" || !message.eventId,
  );
  await saveMessageHistory(scope, sessionId, remaining);
  for (const message of canonicalUsers) {
    await reconcileMessageHistory(scope, sessionId, message);
  }
}

function olderHistoryCursor(
  current: MessageHistoryCursor | null,
  messages: readonly ChatMessage[],
): MessageHistoryCursor | null {
  const oldest = [...messages]
    .filter((message) => message.timestamp !== undefined)
    .sort(compareChatMessages)[0];
  if (!oldest || oldest.timestamp === undefined) return current;
  const candidate = { timestamp: oldest.timestamp, id: oldest.id };
  if (
    !current ||
    candidate.timestamp < current.timestamp ||
    (candidate.timestamp === current.timestamp && candidate.id < current.id)
  ) {
    return candidate;
  }
  return current;
}

function prepareHistoryPrepend(
  feed: HTMLDivElement | null,
  target: {
    current: { scrollHeight: number; scrollTop: number } | null;
  },
): void {
  if (!feed) return;
  target.current = {
    scrollHeight: feed.scrollHeight,
    scrollTop: feed.scrollTop,
  };
}

function isNearFeedBottom(feed: HTMLDivElement): boolean {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 96;
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
    case "device.invite":
      return "The device invitation request";
  }
}

function formatUiError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deviceInvitationFromLink(link: string): boolean {
  if (link.includes("#invite=")) return true;
  try {
    decodeDeviceInvitationLink(link);
    return true;
  } catch {
    return false;
  }
}

function parseGatewayInvitationResult(input: unknown): {
  pairingLink: string;
  expiresAt: number;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The Gateway returned an invalid device invitation.");
  }
  const result = input as Record<string, unknown>;
  if (
    typeof result.pairingLink !== "string" ||
    !result.pairingLink ||
    typeof result.expiresAt !== "number" ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.expiresAt <= Date.now()
  ) {
    throw new Error("The Gateway returned an invalid device invitation.");
  }
  return {
    pairingLink: result.pairingLink,
    expiresAt: result.expiresAt,
  };
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
