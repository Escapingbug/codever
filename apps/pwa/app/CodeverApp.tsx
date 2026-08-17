"use client";

import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  MAX_CODEVER_ATTACHMENTS,
  MAX_CODEVER_ATTACHMENT_BYTES,
  MAX_CODEVER_PROMPT_ATTACHMENT_BYTES,
  encodePairingLink,
  type CodeverAttachment,
  type CommandPayload,
} from "@codever/protocol";
import {
  CommandAcknowledgementTimeoutError,
  CommandCompletionTimeoutError,
  waitForCommandCompletion,
  type CommandCompletion,
} from "./commandLifecycle";
import {
  DeviceInvitationLifecycle,
  InvitationRequestCancelledError,
} from "./deviceInvitationLifecycle";
import {
  MatrixLoginTokenLifecycle,
  MatrixLoginTokenRequestCancelledError,
} from "./matrixLoginTokenLifecycle";
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
import { waitForUiCommit } from "./uiScheduling";
import { hasPairingRoute, pairingRouteFromUrl } from "./pairingRoute";
import {
  NewSessionDialog,
  type NewSessionInput,
} from "./NewSessionDialog";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
import { GatewayForgetDialog } from "./GatewayForgetDialog";
import {
  gatewayProjectKey,
  type GatewaySessionSummary,
} from "./gatewayState";
import { MarkdownContent } from "./MarkdownContent";
import { ToolGroupCard } from "./ToolGroupCard";
import { CODEVER_BUILD_VERSION } from "./buildInfo";
import {
  registerPwaUpdates,
  type PwaUpdateHandle,
  type PwaUpdateState,
} from "./pwaUpdate";
import {
  clearPendingSessionCreateRecovery,
  completedSessionCreateTarget,
  readPendingSessionCreateRecovery,
  sessionCreateRecoveryMatches,
  writePendingSessionCreateRecovery,
  type PendingSessionCreateRecovery,
} from "./sessionCreateRecovery";
import {
  reconcilePendingSessionDeletions,
  sessionsAvailableForAutomaticSelection,
  setSessionDeletionPending,
} from "./pendingSessionDeletion";
import {
  hasShortDeviceInvitation,
  resolveShortDeviceInvitation,
  shortenDeviceInvitation,
} from "./invitationRelay";
import {
  compareChatMessages,
  findOptimisticMessageId,
  isAgentWorkMessage,
  isTransientAgentLifecycleEvent,
  mergeChatMessage,
  mergeChatMessages,
  type ChatMessage,
  type OptimisticMessageReference,
} from "./chatMessages";
import {
  shouldReconcileRecentHistory,
  shouldRecoverVisibleHistory,
} from "./crossDeviceSync";
import { createPromptCommandPayload } from "./commandPayloads";
import { deriveComposerState } from "./composerState";
import {
  connectionStatusForBrowserNetwork,
  deriveConnectionPresentation,
} from "./connectionPresentation";
import { deriveGatewayLiveness } from "./gatewayLiveness";
import {
  formatUserFacingError,
  isCommandRecoveryPendingError,
} from "./userFacingError";
import {
  isProjectExpanded,
  readProjectDisclosureState,
  setProjectCollapsed,
  toggleProjectCollapsed,
  writeProjectDisclosureState,
} from "./projectDisclosureState";
import {
  EMPTY_SESSION_READ_STATE,
  initializeSessionReadState,
  markSessionRead,
  pruneSessionReadState,
  readSessionReadState,
  reconcileSelectedSessionReadState,
  sessionIndicator,
  writeSessionReadState,
  type SessionReadState,
} from "./sessionIndicators";
import {
  compareProjectSessionsForAction,
  compareSessionsForAction,
  projectSessionSummaryLabel,
  sessionListSignal,
  sessionSignalLabel,
  summarizeProjectSessions,
} from "./sessionListOrder";
import { canonicalGatewayProjects } from "./projectCatalog";
import {
  EMPTY_UI_NOTICE_STATE,
  noticesForScope,
  reduceUiNotices,
  type UiNotice,
  type UiNoticeScope,
  type UiNoticeSeverity,
} from "./uiNotices";
import {
  NATIVE_BACK_PRIORITY,
  resolveCodeverBackAction,
  useNativeBackHandler,
} from "./nativeBackNavigation";
import type {
  CodeverClient,
  CodeverCommandReview,
  CodeverCommandSendResult,
  CodeverHistoryRecovery,
  CodeverMessage,
  CodeverNativeRuntimeInfo,
  CodeverPublicTrust,
} from "./client/CodeverClient";
import { CommandReviewRequiredError } from "./client/CodeverClient";
import {
  NATIVE_MANAGED_ACCESS_TOKEN,
  bootstrapNativeMatrixSessionIfAvailable,
  createCodeverClient,
  isNativeManagedMatrixConfig,
} from "./client/createCodeverClient";
import { publicTrustFromWeb } from "./client/web/WebCodeverClient";
import {
  clearMessageHistoryScope,
  clearSessionMessageHistory,
  deleteMessageHistory,
  loadMessageHistoryPage,
  matrixHistoryScope,
  reconcileMessageHistory,
  saveMessageHistory,
  type MessageHistoryCursor,
} from "./messageHistory";
import {
  readSelectedSession,
  writeSelectedSession,
} from "./selectedSessionState";
import {
  CommandRevisionConflictError,
  clearMatrixConfig,
  getOrCreateDeviceIdentity,
  loadMatrixConfig,
  normalizeMatrixConfig,
  resolveMatrixSession,
  saveMatrixConfig,
  type IncomingCodeverMessage,
  type GatewayStateSnapshot,
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
  trustedGatewayConfig,
  type GeneratedDeviceInvitation,
  type PairingPreview,
} from "./pairing";
import {
  loginWithMatrixPassword,
  loginWithMatrixToken,
} from "./matrixAuth";
import {
  MATRIX_STARTUP_RECOVERY_SESSION_KEY,
  shouldDeferStoredMatrixStartupForPairing,
  shouldReloadInterruptedMatrixStartup,
} from "./matrixStartup";

type RevisionConflictNotice = {
  commandId: string;
  expectedRevision: number;
  payload: CommandPayload;
  optimisticMessageId?: string;
  busy: boolean;
};

type NativeCommandReviewNotice = CodeverCommandReview & {
  busy: boolean;
};

type PendingSessionLifecycleRecovery = {
  commandId: string;
  action: "archive" | "restore" | "delete";
  sessionId: string;
  onSucceeded?: () => void | Promise<void>;
  onFailed?: () => void | Promise<void>;
  timer: number | null;
  inFlight: boolean;
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

const DEVICE_INVITATION_RESULT_TIMEOUT_MS = 95_000;
const SESSION_CREATE_RESULT_RECOVERY_MS = 15_000;

class InvitationReauthenticationRequiredError extends Error {
  constructor() {
    super("Matrix reauthentication is required for this invitation.");
    this.name = "InvitationReauthenticationRequiredError";
  }
}

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

function AttachmentList({
  attachments,
  connection,
}: {
  attachments?: CodeverAttachment[];
  connection: CodeverClient | null;
}) {
  if (!attachments?.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => (
        <AttachmentCard
          attachment={attachment}
          connection={connection}
          key={attachment.id}
        />
      ))}
    </div>
  );
}

function AttachmentCard({
  attachment,
  connection,
}: {
  attachment: CodeverAttachment;
  connection: CodeverClient | null;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  async function load(mode: "preview" | "download") {
    if (!connection || busy) return;
    setBusy(mode);
    setError(null);
    try {
      const blob = await connection.downloadAttachment(attachment);
      const url = URL.createObjectURL(blob);
      if (mode === "preview") {
        setPreviewUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return url;
        });
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = attachment.name;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (loadError) {
      setError(formatUiError(loadError));
    } finally {
      setBusy(null);
    }
  }

  const isImage = attachment.mimeType.startsWith("image/");
  return (
    <section className="attachment-card">
      {previewUrl && isImage && (
        // Decrypted attachments use short-lived local blob: URLs, which are
        // intentionally outside the Next image optimization pipeline.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={attachment.name} />
      )}
      <div className="attachment-card-copy">
        <span aria-hidden="true">{isImage ? "▧" : "▤"}</span>
        <span>
          <b title={attachment.name}>{attachment.name}</b>
          <small>
            {attachment.mimeType} · {formatFileSize(attachment.size)}
          </small>
        </span>
      </div>
      <div className="attachment-card-actions">
        {isImage && !previewUrl && (
          <button
            type="button"
            disabled={!connection || busy !== null}
            onClick={() => void load("preview")}
          >
            {busy === "preview" ? "Decrypting…" : "Preview"}
          </button>
        )}
        <button
          type="button"
          disabled={!connection || busy !== null}
          onClick={() => void load("download")}
        >
          {busy === "download" ? "Decrypting…" : "Download"}
        </button>
      </div>
      {error && <small className="attachment-error">{error}</small>}
    </section>
  );
}

function UiNoticeList({
  notices,
  className,
  onDismiss,
}: {
  notices: UiNotice[];
  className?: string;
  onDismiss(key: string): void;
}) {
  if (notices.length === 0) return null;
  return (
    <div className={`ui-notice-list ${className ?? ""}`}>
      {notices.map((notice) => (
        <div
          key={notice.key}
          className={`ui-notice ui-notice-${notice.severity}`}
          role={notice.severity === "error" ? "alert" : "status"}
        >
          <span aria-hidden="true">
            {notice.severity === "error"
              ? "!"
              : notice.severity === "success"
                ? "✓"
                : "i"}
          </span>
          <p>{notice.message}</p>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => onDismiss(notice.key)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function CodeverApp() {
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [feedAwayFromLatest, setFeedAwayFromLatest] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRetryMode, setHistoryRetryMode] = useState<
    "restore" | "older" | null
  >(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [stoppingSessionIds, setStoppingSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [submittingPromptSessionIds, setSubmittingPromptSessionIds] = useState<
    Set<string>
  >(() => new Set());
  const [agentActivitiesBySession, setAgentActivitiesBySession] = useState<
    Map<string, AgentActivity>
  >(() => new Map());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [matrixConfig, setMatrixConfig] = useState<MatrixConnectionConfig>(
    () => loadMatrixConfig() ?? emptyMatrixConfig,
  );
  const [connectionStatus, setConnectionStatus] =
    useState<MatrixConnectionStatus>("offline");
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  // Pairing is an operation layered on top of an already-connected Matrix
  // sync. A routine "connected" status must not erase its timeout/error.
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [nativeRuntime, setNativeRuntime] =
    useState<CodeverNativeRuntimeInfo | null>(null);
  const [pwaUpdateState, setPwaUpdateState] = useState<PwaUpdateState>({
    phase: "current",
    currentVersion: CODEVER_BUILD_VERSION,
  });
  const [deviceKeyId, setDeviceKeyId] = useState<string | null>(null);
  const [activeDeviceCount, setActiveDeviceCount] = useState<number | null>(
    null,
  );
  const [gatewayState, setGatewayState] =
    useState<GatewayStateSnapshot | null>(null);
  const [gatewayLivenessNow, setGatewayLivenessNow] = useState(() => Date.now());
  const [, setGatewayRevision] = useState<number | null>(null);
  const [revisionConflict, setRevisionConflict] =
    useState<RevisionConflictNotice | null>(null);
  const [nativeCommandReview, setNativeCommandReview] =
    useState<NativeCommandReviewNotice | null>(null);
  const [pairingPreview, setPairingPreview] =
    useState<PairingPreview | null>(null);
  const [trustedGateway, setTrustedGateway] =
    useState<CodeverPublicTrust | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [deviceInvitation, setDeviceInvitation] =
    useState<GeneratedDeviceInvitation | null>(null);
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationReauthRequired, setInvitationReauthRequired] =
    useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [forgetDialogOpen, setForgetDialogOpen] = useState(false);
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  const [pendingSessionCreate, setPendingSessionCreate] =
    useState<NewSessionInput | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() =>
    readProjectDisclosureState(
      typeof window === "undefined" ? null : window.localStorage,
    ),
  );
  const [sessionReadState, setSessionReadState] = useState<SessionReadState>(() =>
    typeof window === "undefined"
      ? EMPTY_SESSION_READ_STATE
      : readSessionReadState(window.localStorage),
  );
  const [uiNotices, dispatchUiNotice] = useReducer(
    reduceUiNotices,
    EMPTY_UI_NOTICE_STATE,
  );
  const [sessionLifecycleBusy, setSessionLifecycleBusy] = useState<
    Map<string, "archive" | "restore" | "delete">
  >(() => new Map());
  const [deleteTarget, setDeleteTarget] =
    useState<GatewaySessionSummary | null>(null);
  const [decisionStates, setDecisionStates] = useState<
    Record<string, "pending" | "submitting" | "approved" | "denied">
  >({});
  const feedRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const detailsPopoverRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const codeverClientRef = useRef<CodeverClient | null>(null);
  const matrixStartupGenerationRef = useRef(0);
  const matrixStartupRef = useRef<{
    phase: "connecting" | "securing";
    startedAt: number;
    hiddenAt: number | null;
  } | null>(null);
  const pwaUpdateRef = useRef<PwaUpdateHandle | null>(null);
  const pwaReloadBlockedRef = useRef(false);
  const connectionStatusRef = useRef<MatrixConnectionStatus>("offline");
  const matrixSessionRepairRequiredRef = useRef(false);
  const pendingSessionCreateRecoveryRef =
    useRef<PendingSessionCreateRecovery | null>(null);
  const sessionCreateRecoveryInFlightRef = useRef<{
    commandId: string;
    connection: CodeverClient;
  } | null>(null);
  const sessionCreateRecoveryTimerRef = useRef<number | null>(null);
  const sessionLifecycleRecoveriesRef = useRef(
    new Map<string, PendingSessionLifecycleRecovery>(),
  );
  const pairingAbortRef = useRef<AbortController | null>(null);
  const pairingRecoveryRef = useRef<
    (
      preview: PairingPreview,
      config: MatrixConnectionConfig,
    ) => Promise<void>
  >(async () => {});
  const revisionConflictRef = useRef<RevisionConflictNotice | null>(null);
  const nativeCommandReviewRef = useRef<NativeCommandReviewNotice | null>(null);
  const activePromptCommandsRef = useRef(new Map<string, string>());
  const completedCommandResultsRef = useRef(new Set<string>());
  const optimisticMessagesRef = useRef(
    new Map<string, OptimisticMessageReference>(),
  );
  const reconciledOptimisticMessageIdsRef = useRef(new Set<string>());
  const pendingPromptSessionIdsRef = useRef(new Set<string>());
  const selectedSessionIdRef = useRef<string | null>(null);
  const pendingDeletionSessionIdsRef = useRef(new Set<string>());
  const pendingCreatedSessionIdRef = useRef<string | null>(null);
  const pendingOpenedSessionIdRef = useRef<string | null>(null);
  const activateLocalSessionRef = useRef<(sessionId: string) => void>(() => {});
  const knownGatewaySessionIdsRef = useRef(new Set<string>());
  const knownGatewaySessionUpdatedAtRef = useRef(new Map<string, number>());
  const liveMessagesBySessionRef = useRef(new Map<string, ChatMessage[]>());
  const recentHistoryReconciliationRef = useRef(
    new Map<string, Promise<void>>(),
  );
  const reconcileRecentSessionHistoryCallbackRef = useRef<
    (sessionId: string, connection: CodeverClient) => void
  >(() => {});
  const historyScopeRef = useRef("");
  const historySessionIdRef = useRef<string | null>(null);
  const historyCursorRef = useRef<MessageHistoryCursor | null>(null);
  const historyGenerationRef = useRef(0);
  const historyLoadingRef = useRef(false);
  const deviceInvitationLifecycleRef = useRef(
    new DeviceInvitationLifecycle<GeneratedDeviceInvitation>(),
  );
  const matrixLoginTokenLifecycleRef = useRef(
    new MatrixLoginTokenLifecycle(),
  );
  const invitationExpiryTimeoutRef = useRef<number | null>(null);
  const pendingGatewayInvitationRef = useRef<{
    commandId: string;
    pairingLink: string;
    expiresAt: number;
  } | null>(null);
  const followLatestRef = useRef(true);
  const prependScrollRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  const selected =
    gatewayState?.sessions.find(
      (session) => session.id === selectedSessionId,
    ) ?? null;
  const selectedArchived = selected?.status === "archived";
  const selectedLifecycleAction = selected
    ? sessionLifecycleBusy.get(selected.id) ?? null
    : null;
  const selectedLifecycleBusy = selectedLifecycleAction !== null;
  const deleteDialogBusy = Boolean(
    deleteTarget !== null &&
      sessionLifecycleBusy.get(deleteTarget.id) === "delete",
  );
  const nativeBackAction = resolveCodeverBackAction({
    deleteDialogOpen: deleteTarget !== null,
    deleteDialogBusy,
    newSessionOpen,
    newSessionBusy,
    settingsOpen,
    detailsOpen,
    composerOptionsOpen,
    sessionSearchOpen,
    mobileChatOpen,
  });
  useNativeBackHandler(
    nativeBackAction !== null,
    () => {
      switch (nativeBackAction) {
        case "close-delete-dialog":
          setDeleteTarget(null);
          break;
        case "close-new-session":
          setNewSessionOpen(false);
          break;
        case "close-settings":
          setSettingsOpen(false);
          break;
        case "close-details":
          setDetailsOpen(false);
          break;
        case "close-composer-options":
          setComposerOptionsOpen(false);
          break;
        case "close-session-search":
          setSearch("");
          setSessionSearchOpen(false);
          break;
        case "show-conversations":
          setMobileChatOpen(false);
          break;
        case "block-delete-dialog":
        case "block-new-session":
          break;
        case null:
          return false;
      }
      return true;
    },
    NATIVE_BACK_PRIORITY.app,
  );
  const visibleGatewaySessions = useMemo(
    () => gatewayState?.sessions ?? [],
    [gatewayState],
  );
  const filteredSessions = useMemo(
    () =>
      visibleGatewaySessions.filter((session) =>
        `${session.title} ${session.projectName} ${session.cwd} ${session.provider} ${session.model ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [search, visibleGatewaySessions],
  );
  const activeFilteredSessions = useMemo(
    () => filteredSessions.filter((session) => session.status !== "archived"),
    [filteredSessions],
  );
  const archivedFilteredSessions = useMemo(
    () => filteredSessions.filter((session) => session.status === "archived"),
    [filteredSessions],
  );
  const activeSessionCount =
    visibleGatewaySessions.filter((session) => session.status !== "archived")
      .length ?? 0;
  const archivedSessionCount =
    visibleGatewaySessions.filter((session) => session.status === "archived")
      .length ?? 0;
  const canonicalProjectsById = useMemo(
    () =>
      new Map(
        canonicalGatewayProjects(
          gatewayState?.workspace,
          visibleGatewaySessions,
        ).map((project) => [project.projectId, project]),
      ),
    [gatewayState?.workspace, visibleGatewaySessions],
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
    for (const session of activeFilteredSessions) {
      const key = gatewayProjectKey(matrixConfig.gatewayId, session.projectId);
      const project = canonicalProjectsById.get(session.projectId) ?? session;
      const group = groups.get(key) ?? {
        key,
        projectId: session.projectId,
        projectName: project.projectName,
        cwd: project.cwd,
        sessions: [],
      };
      group.sessions.push(session);
      groups.set(key, group);
    }
    const projects = [...groups.values()];
    for (const project of projects) {
      project.sessions.sort((left, right) =>
        compareSessionsForAction(left, right, sessionReadState),
      );
    }
    projects.sort((left, right) =>
      compareProjectSessionsForAction(
        left.sessions,
        right.sessions,
        sessionReadState,
      ) || left.projectName.localeCompare(right.projectName),
    );
    return projects;
  }, [
    activeFilteredSessions,
    canonicalProjectsById,
    matrixConfig.gatewayId,
    sessionReadState,
  ]);
  const matrixConnectionPresentation = useMemo(
    () => deriveConnectionPresentation(connectionStatus, connectionDetail),
    [connectionDetail, connectionStatus],
  );
  const gatewayLiveness = deriveGatewayLiveness({
    matrixStatus: connectionStatus,
    trusted: trustedGateway !== null,
    gatewayUpdatedAt: gatewayState?.updatedAt,
    now: gatewayLivenessNow,
  });
  const gatewayAvailable = gatewayLiveness.available;
  const displayedConnectionStatus = gatewayLiveness.state === "offline"
    ? "offline"
    : connectionStatus;
  const connectionPresentation = gatewayLiveness.state === "offline"
    ? deriveConnectionPresentation("offline", "matrix_gateway_offline")
    : matrixConnectionPresentation;

  useEffect(() => {
    const timer = window.setInterval(() => setGatewayLivenessNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const matrixSessionRepairRequired =
    connectionDetail === "matrix_session_repair_required";

  useEffect(() => {
    if (!matrixSessionRepairRequired) return;
    const timer = window.setTimeout(() => setSettingsOpen(true), 0);
    return () => window.clearTimeout(timer);
  }, [matrixSessionRepairRequired]);
  const composerNotices = [
    ...noticesForScope(uiNotices, "composer"),
    ...noticesForScope(uiNotices, "attachment"),
  ];
  const sessionNotices = noticesForScope(uiNotices, "session");
  const historyNotices = noticesForScope(uiNotices, "history");
  const gatewayConnected = gatewayAvailable;
  const isStreaming = Boolean(
    selectedSessionId && runningSessionIds.has(selectedSessionId),
  );
  const isStopping = Boolean(
    selectedSessionId && stoppingSessionIds.has(selectedSessionId),
  );
  const agentActivity = selectedSessionId
    ? agentActivitiesBySession.get(selectedSessionId) ?? null
    : null;
  const isPromptSubmitting = Boolean(
    selectedSessionId && submittingPromptSessionIds.has(selectedSessionId),
  );
  const sessionReady = Boolean(
    gatewayAvailable &&
      gatewayState &&
      selected &&
      !selectedArchived,
  );
  const composerState = deriveComposerState({
    connectionStatus,
    gatewayAvailable,
    hasGatewayState: Boolean(gatewayState),
    hasSelectedSession: Boolean(selected),
    selectedArchived,
    attachmentBusy,
    promptSubmitting: isPromptSubmitting,
    isStreaming,
    isStopping,
    hasContent: Boolean(draft.trim() || pendingFiles.length > 0),
  });
  const conversationTitle =
    selected?.title ??
    (trustedGateway
      ? gatewayState
        ? "No active session"
        : "Syncing conversations…"
      : "Connect a computer");
  const activeProvider =
    selected?.provider ?? gatewayState?.workspace.provider ?? "Agent";
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

  function showUiNotice(
    key: string,
    scope: UiNoticeScope,
    severity: UiNoticeSeverity,
    message: string,
    autoDismissMs?: number | null,
  ) {
    dispatchUiNotice({
      type: "show",
      key,
      scope,
      severity,
      message,
      now: Date.now(),
      ...(autoDismissMs === undefined ? {} : { autoDismissMs }),
    });
  }

  function dismissUiNotice(key: string) {
    dispatchUiNotice({ type: "dismiss", key });
  }

  function recoverUiNotice(key: string) {
    dispatchUiNotice({ type: "operation-recovered", key });
  }

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

  function setSessionPromptSubmitting(sessionId: string, submitting: boolean) {
    if (submitting) pendingPromptSessionIdsRef.current.add(sessionId);
    else pendingPromptSessionIdsRef.current.delete(sessionId);
    setSubmittingPromptSessionIds((current) => {
      const next = new Set(current);
      if (submitting) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function hasActivePromptCommand(sessionId: string): boolean {
    return [...activePromptCommandsRef.current.values()].some(
      (candidate) => candidate === sessionId,
    );
  }

  function finishLocalPromptCommand(sessionId: string): void {
    if (
      hasActivePromptCommand(sessionId) ||
      pendingPromptSessionIdsRef.current.has(sessionId)
    ) {
      setSessionRunning(sessionId, true);
      return;
    }
    setSessionRunning(sessionId, false);
    setSessionStopping(sessionId, false);
    setSessionAgentActivity(sessionId, null);
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
    reconcileRecentSessionHistoryCallbackRef.current =
      reconcileRecentSessionHistory;
  });

  useEffect(() => {
    writeProjectDisclosureState(window.localStorage, collapsedProjects);
  }, [collapsedProjects]);

  useEffect(() => {
    writeSessionReadState(window.localStorage, sessionReadState);
  }, [sessionReadState]);

  useEffect(() => {
    if (!Object.values(uiNotices).some((notice) => notice.expiresAt !== null)) {
      return;
    }
    const timer = window.setInterval(() => {
      dispatchUiNotice({ type: "tick", now: Date.now() });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [uiNotices]);

  useEffect(() => {
    const recovery = readPendingSessionCreateRecovery(window.localStorage);
    if (!recovery) return;
    pendingSessionCreateRecoveryRef.current = recovery;
    pwaReloadBlockedRef.current = true;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setPendingSessionCreate(recovery.input);
      setNewSessionBusy(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let lastRecoveryAt = 0;
    const recoverVisibleHistory = () => {
      if (document.visibilityState !== "visible") return;
      const connection = codeverClientRef.current;
      const sessionId = selectedSessionIdRef.current;
      const now = Date.now();
      if (!shouldRecoverVisibleHistory({
        visible: document.visibilityState === "visible",
        connected: connection !== null,
        selectedSessionId: sessionId,
        lastRecoveryAt,
        now,
      })) {
        return;
      }
      lastRecoveryAt = now;
      reconcileRecentSessionHistoryCallbackRef.current(sessionId!, connection!);
    };
    const onVisibilityChange = () => recoverVisibleHistory();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", recoverVisibleHistory);
    window.addEventListener("online", recoverVisibleHistory);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", recoverVisibleHistory);
      window.removeEventListener("online", recoverVisibleHistory);
    };
  }, []);

  useEffect(() => {
    const updater = registerPwaUpdates(setPwaUpdateState, {
      canReload: () => !pwaReloadBlockedRef.current,
    });
    pwaUpdateRef.current = updater;
    return () => {
      pwaUpdateRef.current = null;
      updater.dispose();
    };
  }, []);

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  useEffect(() => {
    if (isNativeManagedMatrixConfig(matrixConfig)) return;
    const reportBrowserOffline = () => {
      connectionStatusRef.current = "offline";
      setConnectionStatus("offline");
      setConnectionDetail(null);
      setConnectionError(null);
    };
    window.addEventListener("offline", reportBrowserOffline);
    if (!navigator.onLine) reportBrowserOffline();
    return () => window.removeEventListener("offline", reportBrowserOffline);
  }, [matrixConfig]);

  useEffect(
    () => () => {
      if (sessionCreateRecoveryTimerRef.current !== null) {
        window.clearTimeout(sessionCreateRecoveryTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const focusSessionSearch = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      setMobileChatOpen(false);
      setSessionSearchOpen(true);
      window.requestAnimationFrame(() => sessionSearchRef.current?.focus());
    };
    window.addEventListener("keydown", focusSessionSearch);
    return () => window.removeEventListener("keydown", focusSessionSearch);
  }, []);

  useEffect(() => {
    if (!detailsOpen) return;
    const closeDetails = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setDetailsOpen(false);
      detailsButtonRef.current?.focus();
    };
    const closeDetailsFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        detailsPopoverRef.current?.contains(target) ||
        detailsButtonRef.current?.contains(target)
      ) {
        return;
      }
      setDetailsOpen(false);
    };
    window.addEventListener("keydown", closeDetails);
    window.addEventListener("pointerdown", closeDetailsFromOutside);
    return () => {
      window.removeEventListener("keydown", closeDetails);
      window.removeEventListener("pointerdown", closeDetailsFromOutside);
    };
  }, [detailsOpen]);

  useEffect(() => {
    const recoverInterruptedStartup = () => {
      const startup = matrixStartupRef.current;
      if (!startup) return;
      const visible = document.visibilityState === "visible";
      if (
        !shouldReloadInterruptedMatrixStartup({
          phase: startup.phase,
          startedAt: startup.startedAt,
          hiddenAt: startup.hiddenAt,
          now: Date.now(),
          visible,
        })
      ) {
        return;
      }
      if (sessionStorage.getItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY)) {
        setConnectionDetail(
          "Android interrupted secure startup again. Keep Codever visible; if it does not continue, tap Disconnect and reconnect.",
        );
        return;
      }
      sessionStorage.setItem(
        MATRIX_STARTUP_RECOVERY_SESSION_KEY,
        String(Date.now()),
      );
      window.location.reload();
    };
    const onVisibilityChange = () => {
      const startup = matrixStartupRef.current;
      if (!startup) return;
      if (document.visibilityState === "hidden") {
        startup.hiddenAt = Date.now();
        setConnectionDetail(
          "Secure startup paused in the background. Return to Codever to resume it.",
        );
        return;
      }
      recoverInterruptedStartup();
      if (!sessionStorage.getItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY)) {
        startup.hiddenAt = null;
        setConnectionDetail("Resuming secure startup…");
      }
    };
    const interval = window.setInterval(recoverInterruptedStartup, 1_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const openRequestedSession = () => {
      const url = new URL(window.location.href);
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
      const requested = hash.get("session");
      if (!requested) return;
      hash.delete("session");
      const nextHash = hash.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`,
      );
      if (
        requested.length > 512 ||
        [...requested].some((character) => /\p{Cc}/u.test(character))
      ) {
        return;
      }
      pendingOpenedSessionIdRef.current = requested;
      if (!knownGatewaySessionIdsRef.current.has(requested)) return;
      pendingOpenedSessionIdRef.current = null;
      activateLocalSessionRef.current(requested);
      setMobileChatOpen(true);
    };
    openRequestedSession();
    window.addEventListener("hashchange", openRequestedSession);
    return () => window.removeEventListener("hashchange", openRequestedSession);
  }, []);

  useEffect(() => {
    const route = pairingRouteFromUrl(window.location.href);
    const link = route.pairingLink;
    const invitation = route.deviceInvitation;
    const shortInvitation = route.shortInvitation;
    const deferStoredStartupForPairing =
      shouldDeferStoredMatrixStartupForPairing({
        pairingLink: link,
        deviceInvitation: invitation,
        shortInvitation,
      });
    const rejectedQueryPairing = route.rejectedQueryPairing;
    if (hasPairingRoute(route)) {
      window.history.replaceState(
        window.history.state,
        "",
        route.sanitizedPath,
      );
    }
    if (invitation) void openDeviceInvitation(invitation);
    else if (link) void openPairingLink(link);
    else if (shortInvitation) void openPairingLink(shortInvitation);
    void (async () => {
      if (rejectedQueryPairing) {
        await Promise.resolve();
        setConnectionError(
          "Pairing links in the URL query are not accepted. Scan the QR code or use a fragment invitation.",
        );
        setSettingsOpen(true);
        return;
      }
      // The invitation flow owns native bridge startup for this boot. Restoring
      // a stored native session at the same time would attach a second Web
      // client before the one-time Matrix bootstrap can acquire the port.
      if (deferStoredStartupForPairing) return;
      const identity = await getOrCreateDeviceIdentity();
      const trust = await loadTrustedGateway(identity);
      const stored = loadMatrixConfig() ?? emptyMatrixConfig;
      if (trust) {
        clearPendingPairing();
        setTrustedGateway(publicTrustFromWeb(trust));
        setActiveDeviceCount(trust.activeDeviceCount ?? null);
        setDeviceKeyId(identity.keyId);
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
        const recoveryRequestedAt = Number(
          sessionStorage.getItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY),
        );
        const resumeInterruptedStartup =
          Number.isFinite(recoveryRequestedAt) &&
          recoveryRequestedAt > 0 &&
          Date.now() - recoveryRequestedAt < 5 * 60_000;
        setSettingsOpen(false);
        await connectCodeverClient(
          trustedConfig,
          true,
          resumeInterruptedStartup,
        );
        return;
      }
      if (isNativeManagedMatrixConfig(stored)) {
        clearPendingPairing();
        setMatrixConfig(stored);
        setSettingsOpen(false);
        await connectCodeverClient(stored, true, true);
        return;
      }
      const pending = await loadPendingPairingRecovery(identity);
      if (!pending) {
        setSettingsOpen(true);
        return;
      }
      if (pending.status === "expired") {
        setConnectionError(
          "The previous invitation expired. Scan a new QR code from your computer.",
        );
        setSettingsOpen(true);
        return;
      }
      const preview = pending.preview;
      const transport = preview.transport;
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

  useEffect(() => {
    const openRuntimePairingRoute = () => {
      const route = pairingRouteFromUrl(window.location.href);
      if (!route.pairingLink && !route.deviceInvitation && !route.shortInvitation) return;
      window.history.replaceState(
        window.history.state,
        "",
        route.sanitizedPath,
      );
      if (route.deviceInvitation) void openDeviceInvitation(route.deviceInvitation);
      else if (route.pairingLink) void openPairingLink(route.pairingLink);
      else if (route.shortInvitation) void openPairingLink(route.shortInvitation);
    };
    window.addEventListener("hashchange", openRuntimePairingRoute);
    return () => window.removeEventListener("hashchange", openRuntimePairingRoute);
    // Runtime invitation delivery is intentionally registered once. The
    // handlers read current refs/state and own their async serialization.
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
      setFeedAwayFromLatest(!isNearFeedBottom(feed));
      return;
    }
    if (followLatestRef.current) {
      feed.scrollTo({
        top: feed.scrollHeight,
        behavior: "auto",
      });
      setFeedAwayFromLatest(false);
    } else {
      setFeedAwayFromLatest(!isNearFeedBottom(feed));
    }
  }, [messages, isStreaming]);

  useEffect(
    () => () => {
      matrixStartupGenerationRef.current += 1;
      pairingAbortRef.current?.abort();
      clearSessionLifecycleRecoveries();
      codeverClientRef.current?.dispose();
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
      setSessionAgentActivity(sessionId, (current) => {
        return reduceAgentActivity(current, incoming.raw);
      });
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
      if (sessionId && incoming.replacesEventId) {
        const replacementTarget = incoming.replacesEventId;
        removeLiveMessage(sessionId, replacementTarget);
        if (selectedSessionIdRef.current === sessionId) {
          setMessages((current) =>
            current.filter(
              (message) =>
                message.id !== replacementTarget &&
                message.eventId !== replacementTarget &&
                !message.eventAliases?.includes(replacementTarget),
            ),
          );
        }
        if (historyScopeRef.current) {
          void deleteMessageHistory(
            historyScopeRef.current,
            replacementTarget,
          ).catch((error) => {
            showUiNotice(
              "history:lifecycle-cleanup",
              "history",
              "warning",
              `Transient lifecycle history could not be removed: ${formatUiError(error)}`,
            );
          });
        }
      }
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
        incoming.originDeviceId === codeverClientRef.current?.deviceId,
    );
    const optimisticMessageId = ownUserMessage
      ? findOptimisticMessageId(optimisticMessagesRef.current.values(), message)
      : undefined;
    if (optimisticMessageId) {
      reconciledOptimisticMessageIdsRef.current.add(optimisticMessageId);
      optimisticMessagesRef.current.delete(optimisticMessageId);
      recoverUiNotice("composer:send");
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
        showUiNotice(
          "history:save",
          "history",
          "warning",
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

  function recoverLateHistory(page: CodeverHistoryRecovery): void {
    const scope = historyScopeRef.current;
    if (!scope) return;
    const recovered = page.messages.map((message) =>
      chatMessageFromIncoming(
        { ...incomingMessageFromClient(message), historical: true },
        message.sessionId ?? page.sessionId,
      ),
    );
    // Persist before checking the selected-session generation. A response may
    // arrive after the user switched conversations and must still be visible
    // when they return.
    void persistMessageHistoryPage(scope, page.sessionId, recovered)
      .then(() => {
        if (historySessionIdRef.current !== page.sessionId) return;
        historyCursorRef.current = olderHistoryCursor(
          historyCursorRef.current,
          recovered,
        );
        setMessages((current) => mergeChatMessages(current, recovered));
        setHistoryHasMore(page.hasMore);
        setHistoryError(null);
        setHistoryRetryMode(null);
      })
      .catch((error) => {
        if (historySessionIdRef.current === page.sessionId) {
          setHistoryError(
            `Recovered history could not be saved: ${formatUiError(error)}`,
          );
        }
      });
  }

  function reconcileRecentSessionHistory(
    sessionId: string,
    connection: CodeverClient,
  ): void {
    if (
      historySessionIdRef.current !== sessionId ||
      historyLoadingRef.current ||
      recentHistoryReconciliationRef.current.has(sessionId)
    ) {
      return;
    }
    const scope = historyScopeRef.current;
    if (!scope) return;
    const generation = historyGenerationRef.current;
    const operation = (async () => {
      const remote = await connection.loadRecentHistory(sessionId);
      const recovered = remote.messages.map((message) =>
        chatMessageFromIncoming(
          { ...incomingMessageFromClient(message), historical: true },
          message.sessionId ?? sessionId,
        ),
      );
      if (recovered.length > 0) {
        await persistMessageHistoryPage(scope, sessionId, recovered);
      }
      if (
        codeverClientRef.current !== connection ||
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      if (recovered.length > 0) {
        historyCursorRef.current = olderHistoryCursor(
          historyCursorRef.current,
          recovered,
        );
        setMessages((current) => mergeChatMessages(current, recovered));
      }
      setHistoryHasMore((current) => current || remote.hasMore);
      setHistoryError(null);
      setHistoryRetryMode(null);
      recoverUiNotice("history:cross-device-sync");
    })()
      .catch((error) => {
        if (
          codeverClientRef.current === connection &&
          historySessionIdRef.current === sessionId
        ) {
          showUiNotice(
            "history:cross-device-sync",
            "history",
            "warning",
            `Recent messages from another device could not be synchronized: ${formatUiError(error)}`,
          );
        }
      })
      .finally(() => {
        if (recentHistoryReconciliationRef.current.get(sessionId) === operation) {
          recentHistoryReconciliationRef.current.delete(sessionId);
        }
      });
    recentHistoryReconciliationRef.current.set(sessionId, operation);
  }

  async function restoreSessionHistory(
    sessionId: string,
    connection: CodeverClient | null = codeverClientRef.current,
  ): Promise<void> {
    const scope = historyScopeRef.current;
    if (!scope) return;
    const generation = ++historyGenerationRef.current;
    historySessionIdRef.current = sessionId;
    historyCursorRef.current = null;
    followLatestRef.current = true;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    setHistoryRetryMode(null);
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
      const remoteMessages = remote.messages.map((message) =>
        chatMessageFromIncoming(
          { ...incomingMessageFromClient(message), historical: true },
          message.sessionId ?? sessionId,
        ),
      );
      if (remoteMessages.length > 0) {
        await persistMessageHistoryPage(scope, sessionId, remoteMessages);
      }
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      if (remoteMessages.length > 0) {
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
      if (
        generation === historyGenerationRef.current &&
        historySessionIdRef.current === sessionId
      ) {
        setHistoryError(
          `Conversation history could not be restored: ${formatUiError(error)}`,
        );
        setHistoryRetryMode("restore");
      }
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
    setHistoryError(null);
    setHistoryRetryMode(null);
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
        const connection = codeverClientRef.current;
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
        const prefetchedMessages = prefetched.messages.map((message) =>
          chatMessageFromIncoming(
            { ...incomingMessageFromClient(message), historical: true },
            message.sessionId ?? sessionId,
          ),
        );
        if (prefetchedMessages.length > 0) {
          await persistMessageHistoryPage(
            scope,
            sessionId,
            prefetchedMessages,
          );
        }
        if (
          generation !== historyGenerationRef.current ||
          historySessionIdRef.current !== sessionId
        ) {
          return;
        }
        setHistoryHasMore(cached.hasMore || prefetched.hasMore);
        return;
      }

      const connection = codeverClientRef.current;
      if (!connection) {
        setHistoryHasMore(false);
        return;
      }
      const remote = await connection.loadHistoryPage(sessionId);
      const olderMessages = remote.messages.map((message) =>
        chatMessageFromIncoming(
          { ...incomingMessageFromClient(message), historical: true },
          message.sessionId ?? sessionId,
        ),
      );
      if (olderMessages.length > 0) {
        await persistMessageHistoryPage(scope, sessionId, olderMessages);
      }
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      if (olderMessages.length > 0) {
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
      if (
        generation === historyGenerationRef.current &&
        historySessionIdRef.current === sessionId
      ) {
        setHistoryError(
          `Older history could not be loaded: ${formatUiError(error)}`,
        );
        setHistoryRetryMode("older");
      }
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
    setFeedAwayFromLatest(!followLatestRef.current);
    if (
      feed.scrollTop <= 80 &&
      historyHasMore &&
      !historyLoadingRef.current
    ) {
      void loadOlderHistory();
    }
  }

  function scrollFeedToLatest() {
    const feed = feedRef.current;
    if (!feed) return;
    followLatestRef.current = true;
    feed.scrollTo({ top: feed.scrollHeight, behavior: "auto" });
    setFeedAwayFromLatest(false);
  }

  function activateLocalSession(
    sessionId: string | null,
    connection: CodeverClient | null = codeverClientRef.current,
    revealProject = true,
    skipHistoryRestore = false,
  ) {
    const sessionChanged = selectedSessionIdRef.current !== sessionId;
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    if (historyScopeRef.current) {
      writeSelectedSession(
        window.localStorage,
        historyScopeRef.current,
        sessionId,
      );
    }
    const openedSession = gatewayState?.sessions.find(
      (session) => session.id === sessionId,
    );
    if (openedSession) {
      setSessionReadState((current) => markSessionRead(current, openedSession));
      if (sessionChanged && revealProject) {
        const projectKey = gatewayProjectKey(
          matrixConfig.gatewayId,
          openedSession.projectId,
        );
        setCollapsedProjects((current) =>
          setProjectCollapsed(current, projectKey, false),
        );
      }
    }
    if (!sessionChanged) return;
    followLatestRef.current = true;
    setFeedAwayFromLatest(false);
    setComposerOptionsOpen(false);
    historyGenerationRef.current += 1;
    historySessionIdRef.current = sessionId;
    historyCursorRef.current = null;
    setMessages([]);
    setDecisionStates({});
    setHistoryHasMore(Boolean(sessionId) && !skipHistoryRestore);
    setHistoryError(null);
    setHistoryRetryMode(null);
    if (!sessionId || skipHistoryRestore) {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    } else if (connection) {
      void restoreSessionHistory(sessionId, connection);
    }
  }
  activateLocalSessionRef.current = (sessionId) => activateLocalSession(sessionId);

  function setSessionCreateReloadBlocked(blocked: boolean): void {
    pwaReloadBlockedRef.current = blocked;
    if (!blocked) pwaUpdateRef.current?.resumeDeferredUpdate();
  }

  function clearPendingSessionCreateUi(): void {
    setPendingSessionCreate(null);
    setNewSessionBusy(false);
    setSessionCreateReloadBlocked(false);
  }

  function rememberPendingSessionCreate(
    input: NewSessionInput,
    commandId: string,
  ): PendingSessionCreateRecovery {
    const recovery: PendingSessionCreateRecovery = {
      version: 1,
      commandId,
      gatewayId: matrixConfig.gatewayId,
      conversationId: matrixConfig.conversationId,
      createdAt: Date.now(),
      input,
    };
    pendingSessionCreateRecoveryRef.current = recovery;
    setPendingSessionCreate(input);
    setNewSessionBusy(true);
    setSessionCreateReloadBlocked(true);
    try {
      writePendingSessionCreateRecovery(window.localStorage, recovery);
    } catch (error) {
      showUiNotice(
        "session:create-recovery-storage",
        "session",
        "warning",
        `This session will keep retrying while this page remains open, but its recovery state could not be saved: ${formatUiError(error)}`,
      );
    }
    return recovery;
  }

  function forgetPendingSessionCreate(commandId?: string): void {
    const recovery = pendingSessionCreateRecoveryRef.current;
    if (commandId && recovery?.commandId !== commandId) return;
    pendingSessionCreateRecoveryRef.current = null;
    if (sessionCreateRecoveryTimerRef.current !== null) {
      window.clearTimeout(sessionCreateRecoveryTimerRef.current);
      sessionCreateRecoveryTimerRef.current = null;
    }
    try {
      clearPendingSessionCreateRecovery(window.localStorage, commandId);
    } catch (error) {
      showUiNotice(
        "session:create-recovery-storage",
        "session",
        "warning",
        `The completed session recovery marker could not be cleared: ${formatUiError(error)}`,
      );
    }
  }

  function schedulePendingSessionCreateRecovery(
    connection: CodeverClient,
  ): void {
    if (sessionCreateRecoveryTimerRef.current !== null) {
      window.clearTimeout(sessionCreateRecoveryTimerRef.current);
    }
    sessionCreateRecoveryTimerRef.current = window.setTimeout(() => {
      sessionCreateRecoveryTimerRef.current = null;
      if (
        codeverClientRef.current === connection &&
        connectionStatusRef.current === "connected"
      ) {
        continuePendingSessionCreate(connection);
      }
    }, 5_000);
  }

  function continuePendingSessionCreate(
    connection: CodeverClient,
    acknowledgedCommand?: CodeverCommandSendResult,
  ): void {
    const recovery = pendingSessionCreateRecoveryRef.current;
    if (!recovery) return;
    if (
      acknowledgedCommand &&
      acknowledgedCommand.commandId !== recovery.commandId
    ) {
      return;
    }
    if (
      sessionCreateRecoveryInFlightRef.current?.commandId ===
      recovery.commandId
    ) {
      return;
    }
    sessionCreateRecoveryInFlightRef.current = {
      commandId: recovery.commandId,
      connection,
    };
    void (async () => {
      try {
        const sent =
          acknowledgedCommand ??
          (await connection.recoverCommand(recovery.commandId));
        recoverUiNotice("session:create");
        await settleSessionCreate(connection, sent);
      } catch {
        if (
          pendingSessionCreateRecoveryRef.current?.commandId !==
          recovery.commandId
        ) {
          return;
        }
        showUiNotice(
          "session:create",
          "session",
          "warning",
          "Session creation is still queued securely. Codever will resume the same command when your computer reconnects.",
        );
        if (
          codeverClientRef.current === connection &&
          connectionStatusRef.current === "connected"
        ) {
          schedulePendingSessionCreateRecovery(connection);
        }
      } finally {
        if (
          sessionCreateRecoveryInFlightRef.current?.commandId ===
          recovery.commandId
        ) {
          sessionCreateRecoveryInFlightRef.current = null;
        }
        const currentConnection = codeverClientRef.current;
        if (
          pendingSessionCreateRecoveryRef.current?.commandId ===
            recovery.commandId &&
          currentConnection &&
          currentConnection !== connection &&
          connectionStatusRef.current === "connected"
        ) {
          continuePendingSessionCreate(currentConnection);
        }
      }
    })();
  }

  async function connectCodeverClient(
    configInput = matrixConfig,
    closeSettings = true,
    recoveringInterruptedStartup = false,
  ): Promise<CodeverClient | null> {
    // Native status callbacks may run before createCodeverClient() returns.
    // Remember a repair result synchronously so the routine post-connect close
    // cannot immediately undo the recovery dialog opened by that callback.
    let keepSettingsOpenForRepair = false;
    matrixSessionRepairRequiredRef.current = false;
    const storedSessionCreateRecovery = pendingSessionCreateRecoveryRef.current;
    const sessionCreateRecovery =
      storedSessionCreateRecovery &&
      sessionCreateRecoveryMatches(storedSessionCreateRecovery, configInput)
        ? storedSessionCreateRecovery
        : null;
    if (storedSessionCreateRecovery && !sessionCreateRecovery) {
      forgetPendingSessionCreate(storedSessionCreateRecovery.commandId);
    }
    const startupGeneration = matrixStartupGenerationRef.current + 1;
    matrixStartupGenerationRef.current = startupGeneration;
    const isCurrentStartup = () =>
      matrixStartupGenerationRef.current === startupGeneration;
    codeverClientRef.current?.dispose();
    codeverClientRef.current = null;
    if (!recoveringInterruptedStartup) {
      sessionStorage.removeItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY);
    }
    matrixStartupRef.current = {
      phase: "connecting",
      startedAt: Date.now(),
      hiddenAt: null,
    };
    optimisticMessagesRef.current.clear();
    reconciledOptimisticMessageIdsRef.current.clear();
    pendingPromptSessionIdsRef.current.clear();
    setSubmittingPromptSessionIds(new Set());
    revisionConflictRef.current = null;
    nativeCommandReviewRef.current = null;
    activePromptCommandsRef.current.clear();
    completedCommandResultsRef.current.clear();
    setRevisionConflict(null);
    setNativeCommandReview(null);
    setConnectionError(null);
    setConnectionDetail("Preparing your connection…");
    connectionStatusRef.current = "connecting";
    setConnectionStatus("connecting");
    setMessages([]);
    setSelectedSessionId(null);
    setRunningSessionIds(new Set());
    setStoppingSessionIds(new Set());
    setAgentActivitiesBySession(new Map());
    pendingCreatedSessionIdRef.current = null;
    pendingDeletionSessionIdsRef.current = new Set();
    setSessionLifecycleBusy(new Map());
    setPendingSessionCreate(sessionCreateRecovery?.input ?? null);
    setNewSessionBusy(Boolean(sessionCreateRecovery));
    setSessionCreateReloadBlocked(Boolean(sessionCreateRecovery));
    knownGatewaySessionIdsRef.current.clear();
    knownGatewaySessionUpdatedAtRef.current.clear();
    recentHistoryReconciliationRef.current.clear();
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
    setHistoryError(null);
    setHistoryRetryMode(null);
    try {
      const normalized = normalizeMatrixConfig(configInput);
      historyScopeRef.current = matrixHistoryScope({
        gatewayId: normalized.gatewayId,
        conversationId: normalized.conversationId,
        roomId: normalized.roomId,
      });
      const rememberedSessionId = readSelectedSession(
        window.localStorage,
        historyScopeRef.current,
      );
      selectedSessionIdRef.current = rememberedSessionId;
      setSelectedSessionId(rememberedSessionId);
      setMatrixConfig(normalized);
      saveMatrixConfig(normalized);
      const connection = await createCodeverClient(normalized, {
        onMessage(message) {
          if (isCurrentStartup()) {
            receiveMatrixMessage(incomingMessageFromClient(message));
          }
        },
        onStatus(status, detail) {
          if (!isCurrentStartup()) return;
          const presentedStatus = isNativeManagedMatrixConfig(normalized)
            ? status
            : connectionStatusForBrowserNetwork(status, navigator.onLine);
          if (
            matrixStartupRef.current &&
            (presentedStatus === "connecting" || presentedStatus === "securing")
          ) {
            matrixStartupRef.current.phase = presentedStatus;
          }
          connectionStatusRef.current = presentedStatus;
          matrixSessionRepairRequiredRef.current =
            presentedStatus === "error" &&
            detail === "matrix_session_repair_required";
          setConnectionStatus(presentedStatus);
          setConnectionDetail(presentedStatus === "offline" ? null : detail ?? null);
          if (presentedStatus === "error") {
            const presentation = deriveConnectionPresentation(presentedStatus, detail);
            setConnectionError(presentation.detail);
            if (detail === "matrix_session_repair_required") {
              keepSettingsOpenForRepair = true;
              setSettingsOpen(true);
            }
          } else if (
            presentedStatus === "reconnecting" ||
            presentedStatus === "offline"
          ) {
            setConnectionError(null);
          }
          if (
            presentedStatus === "connected" ||
            presentedStatus === "offline" ||
            presentedStatus === "error"
          ) {
            matrixStartupRef.current = null;
          }
          if (presentedStatus === "connected") {
            sessionStorage.removeItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY);
            setConnectionError(null);
            dispatchUiNotice({ type: "scope-recovered", scope: "connection" });
            window.setTimeout(() => {
              const activeConnection = codeverClientRef.current;
              if (activeConnection) {
                continuePendingSessionCreate(activeConnection);
              }
            }, 0);
          }
        },
        onNativeRuntime(runtime) {
          if (isCurrentStartup()) setNativeRuntime(runtime);
        },
        onTrustUpdated(trust) {
          if (!isCurrentStartup()) return;
          setTrustedGateway(trust);
          setActiveDeviceCount(trust?.activeDeviceCount ?? null);
          if (trust) {
            setPairingPreview(null);
            setPairingBusy(false);
            setPairingError(null);
            setConnectionError(null);
          }
        },
        onCollaborationState(state) {
          if (!isCurrentStartup()) return;
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
            const previousUpdatedAt = knownGatewaySessionUpdatedAtRef.current;
            const nextUpdatedAt = new Map(
              state.gatewayState.sessions.map((session) => [
                session.id,
                session.updatedAt,
              ]),
            );
            const nextSessionIds = new Set(
              state.gatewayState.sessions.map((session) => session.id),
            );
            const pendingDeletionSessionIds =
              reconcilePendingSessionDeletions(
                pendingDeletionSessionIdsRef.current,
                nextSessionIds,
              );
            if (
              pendingDeletionSessionIds.size !==
              pendingDeletionSessionIdsRef.current.size
            ) {
              pendingDeletionSessionIdsRef.current =
                pendingDeletionSessionIds;
            }
            for (const previousSessionId of knownGatewaySessionIdsRef.current) {
              if (nextSessionIds.has(previousSessionId)) continue;
              liveMessagesBySessionRef.current.delete(previousSessionId);
              if (historyScopeRef.current) {
                void clearSessionMessageHistory(
                  historyScopeRef.current,
                  previousSessionId,
                ).catch((error) => {
                  showUiNotice(
                    "history:deleted-session-cleanup",
                    "history",
                    "warning",
                    `Deleted session history could not be cleared locally: ${formatUiError(error)}`,
                  );
                });
              }
            }
            knownGatewaySessionIdsRef.current = nextSessionIds;
            knownGatewaySessionUpdatedAtRef.current = nextUpdatedAt;
            setDeleteTarget((current) =>
              current
                ? state.gatewayState!.sessions.find(
                    (session) => session.id === current.id,
                  ) ?? null
                : null,
            );
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
                if (session.activityPhase === "starting") {
                  next.set(session.id, STARTING_AGENT_ACTIVITY);
                } else if (
                  session.activityPhase === "stopping" ||
                  session.status === "stopping"
                ) {
                  next.set(session.id, STOPPING_AGENT_ACTIVITY);
                } else if (
                  session.activityPhase === "working" ||
                  session.status === "running"
                ) {
                  next.set(
                    session.id,
                    current.get(session.id) ?? WORKING_AGENT_ACTIVITY,
                  );
                }
              }
              return next;
            });
            const selectableSessions = sessionsAvailableForAutomaticSelection(
              state.gatewayState.sessions,
              pendingDeletionSessionIds,
            );
            const availableIds = new Set(
              selectableSessions.map((session) => session.id),
            );
            const openedSession = pendingOpenedSessionIdRef.current;
            const activeSessions = selectableSessions.filter(
              (session) => session.status !== "archived",
            );
            const activeIds = new Set(
              activeSessions.map((session) => session.id),
            );
            const pendingCreated = pendingCreatedSessionIdRef.current;
            const nextSessionId =
              openedSession && availableIds.has(openedSession)
                ? openedSession
                : pendingCreated && availableIds.has(pendingCreated)
                ? pendingCreated
                : selectedSessionIdRef.current &&
                    availableIds.has(selectedSessionIdRef.current)
                  ? selectedSessionIdRef.current
                : state.gatewayState.currentSessionId &&
                      activeIds.has(state.gatewayState.currentSessionId)
                    ? state.gatewayState.currentSessionId
                    : activeSessions[0]?.id ??
                      selectableSessions[0]?.id ??
                      null;
            if (openedSession) {
              pendingOpenedSessionIdRef.current = null;
              if (openedSession === nextSessionId) setMobileChatOpen(true);
            }
            if (pendingCreated === nextSessionId) {
              pendingCreatedSessionIdRef.current = null;
              clearPendingSessionCreateUi();
              setMobileChatOpen(true);
            }
            setSessionReadState((current) => {
              const initialized = initializeSessionReadState(
                current,
                state.gatewayState!.sessions,
              );
              const pruned = pruneSessionReadState(initialized, availableIds);
              return reconcileSelectedSessionReadState(
                pruned,
                state.gatewayState!.sessions,
                nextSessionId,
              );
            });
            const shouldRevealNextSession =
              (openedSession === nextSessionId ||
                pendingCreated === nextSessionId) &&
              nextSessionId !== selectedSessionIdRef.current;
            activateLocalSession(
              nextSessionId,
              codeverClientRef.current,
              shouldRevealNextSession,
              pendingCreated === nextSessionId,
            );
            const previousSelectedUpdatedAt = nextSessionId
              ? previousUpdatedAt.get(nextSessionId)
              : undefined;
            const nextSelectedUpdatedAt = nextSessionId
              ? nextUpdatedAt.get(nextSessionId)
              : undefined;
            const activeConnection = codeverClientRef.current;
            if (
              nextSessionId &&
              activeConnection &&
              shouldReconcileRecentHistory({
                selectedSessionId: nextSessionId,
                previousUpdatedAt: previousSelectedUpdatedAt,
                nextUpdatedAt: nextSelectedUpdatedAt,
              })
            ) {
              reconcileRecentSessionHistory(nextSessionId, activeConnection);
            }
          }
        },
        onConvergenceRequired() {
          if (!isCurrentStartup()) return;
          const activeConnection = codeverClientRef.current;
          const sessionId = selectedSessionIdRef.current;
          if (activeConnection && sessionId) {
            reconcileRecentSessionHistory(sessionId, activeConnection);
          }
        },
        onCommandReviewRequired(review) {
          if (!isCurrentStartup()) return;
          if (!review) {
            nativeCommandReviewRef.current = null;
            setNativeCommandReview(null);
            return;
          }
          const notice: NativeCommandReviewNotice = {
            ...review,
            busy: false,
          };
          nativeCommandReviewRef.current = notice;
          setNativeCommandReview(notice);
        },
        onCommandResult(result) {
          if (!isCurrentStartup()) return;
          const promptSessionId =
            activePromptCommandsRef.current.get(result.commandId);
          if (promptSessionId) {
            activePromptCommandsRef.current.delete(result.commandId);
            completedCommandResultsRef.current.delete(result.commandId);
            finishLocalPromptCommand(promptSessionId);
            recoverUiNotice("composer:send");
          } else {
            completedCommandResultsRef.current.add(result.commandId);
          }
        },
        onHistoryRecovered(page) {
          if (isCurrentStartup()) recoverLateHistory(page);
        },
      });
      if (!isCurrentStartup()) {
        connection.dispose();
        return null;
      }
      codeverClientRef.current = connection;
      setDeviceKeyId(connection.deviceId);
      if (closeSettings && !keepSettingsOpenForRepair) setSettingsOpen(false);
      void connection.ready
        .then(() => {
          if (codeverClientRef.current !== connection) return;
          continuePendingSessionCreate(connection);
          const sessionId = selectedSessionIdRef.current;
          if (sessionId) void restoreSessionHistory(sessionId, connection);
        })
        .catch(() => undefined);
      return connection;
    } catch (error) {
      if (!isCurrentStartup()) return null;
      matrixStartupRef.current = null;
      connectionStatusRef.current = "error";
      setConnectionStatus("error");
      setConnectionDetail(null);
      setConnectionError(formatUiError(error));
      return null;
    }
  }

  function disconnectClient() {
    const queuedSessionCreate = pendingSessionCreateRecoveryRef.current;
    matrixStartupGenerationRef.current += 1;
    const disconnectingClient = codeverClientRef.current;
    codeverClientRef.current = null;
    void disconnectingClient?.disconnect().catch((error) => {
      connectionStatusRef.current = "error";
      setConnectionStatus("error");
      setConnectionError(
        `The client could not disconnect cleanly: ${formatUiError(error)}`,
      );
    });
    optimisticMessagesRef.current.clear();
    reconciledOptimisticMessageIdsRef.current.clear();
    pendingPromptSessionIdsRef.current.clear();
    setSubmittingPromptSessionIds(new Set());
    revisionConflictRef.current = null;
    nativeCommandReviewRef.current = null;
    activePromptCommandsRef.current.clear();
    completedCommandResultsRef.current.clear();
    pendingCreatedSessionIdRef.current = null;
    pendingDeletionSessionIdsRef.current = new Set();
    setSessionLifecycleBusy(new Map());
    setPendingSessionCreate(queuedSessionCreate?.input ?? null);
    setNewSessionBusy(Boolean(queuedSessionCreate));
    setSessionCreateReloadBlocked(Boolean(queuedSessionCreate));
    if (sessionCreateRecoveryTimerRef.current !== null) {
      window.clearTimeout(sessionCreateRecoveryTimerRef.current);
      sessionCreateRecoveryTimerRef.current = null;
    }
    knownGatewaySessionIdsRef.current.clear();
    knownGatewaySessionUpdatedAtRef.current.clear();
    recentHistoryReconciliationRef.current.clear();
    liveMessagesBySessionRef.current.clear();
    setRevisionConflict(null);
    setNativeCommandReview(null);
    matrixStartupRef.current = null;
    sessionStorage.removeItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY);
    connectionStatusRef.current = "offline";
    setConnectionStatus("offline");
    setConnectionDetail(null);
    setConnectionError(null);
    setPairingError(null);
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
    setHistoryError(null);
    setHistoryRetryMode(null);
    deviceInvitationLifecycleRef.current.clear();
    matrixLoginTokenLifecycleRef.current.clear();
    pendingGatewayInvitationRef.current = null;
    if (invitationExpiryTimeoutRef.current !== null) {
      window.clearTimeout(invitationExpiryTimeoutRef.current);
      invitationExpiryTimeoutRef.current = null;
    }
    setDeviceInvitation(null);
    setInvitationBusy(false);
    setInvitationError(null);
  }

  function detachClientForNativeBootstrap() {
    // Supersede any startup that has acquired the native port but has not yet
    // published its CodeverClient. A stale startup disposes itself once its
    // current bridge operation settles, releasing the lease to bootstrap.
    matrixStartupGenerationRef.current += 1;
    const attachedClient = codeverClientRef.current;
    codeverClientRef.current = null;
    attachedClient?.dispose();
    matrixStartupRef.current = null;
    sessionStorage.removeItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY);
    connectionStatusRef.current = "connecting";
    setConnectionStatus("connecting");
    setConnectionDetail("Transferring the native connection to this invitation…");
  }

  function settleNativeBootstrapTransfer(status: "offline" | "error") {
    connectionStatusRef.current = status;
    setConnectionStatus(status);
    setConnectionDetail(null);
  }

  function forgetMatrixConfig() {
    const historyScope = historyScopeRef.current;
    pairingAbortRef.current?.abort();
    disconnectClient();
    const queuedSessionCreate = pendingSessionCreateRecoveryRef.current;
    if (queuedSessionCreate) {
      forgetPendingSessionCreate(queuedSessionCreate.commandId);
      clearPendingSessionCreateUi();
    }
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
    setPairingError(null);
    setMessages([]);
    if (historyScope) {
      writeSelectedSession(window.localStorage, historyScope, null);
    }
    historyScopeRef.current = "";
    if (historyScope) {
      void clearMessageHistoryScope(historyScope).catch((error) => {
        showUiNotice(
          "history:clear-all",
          "history",
          "warning",
          `Conversation history could not be cleared: ${formatUiError(error)}`,
        );
      });
    }
    setSettingsOpen(true);
  }

  async function openPairingLink(link: string) {
    setConnectionError(null);
    setPairingError(null);
    try {
      if (
        hasShortDeviceInvitation(
          link,
          typeof window === "undefined"
            ? "https://codever.invalid/"
            : window.location.href,
        )
      ) {
        const invitationLink = await resolveShortDeviceInvitation(
          link,
          window.location.href,
        );
        await openDeviceInvitation(invitationLink);
        return;
      }
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
    setPairingError(null);
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
          : matrixSessionRepairRequiredRef.current
            ? { accessToken: "", matrixDeviceId: "" }
          : {}),
      };
      setPairingPreview(preview);
      setMatrixConfig(nextConfig);
      setSettingsOpen(true);

      const matrixLogin = invitation.matrixLogin;
      if (!matrixLogin) return;
      if (matrixLogin.expiresAt <= Date.now()) {
        setConnectionError(
          "The one-time sign-in expired. Sign in below; the invitation may still be valid.",
        );
        return;
      }
      try {
        detachClientForNativeBootstrap();
        const nativeBootstrap = await bootstrapNativeMatrixSessionIfAvailable({
          homeserver: matrixLogin.homeserver,
          oneTimeLoginToken: matrixLogin.loginToken,
          expectedUserId: matrixLogin.userId,
          deviceName: browserDeviceName(),
          roomBinding: {
            roomId: transport.roomId,
            gatewayId: preview.gatewayId,
            conversationId: transport.roomId,
            gatewayUserId: transport.userId,
            gatewayDeviceId: transport.deviceId,
            gatewayDeviceEd25519: transport.ed25519,
          },
        });
        if (nativeBootstrap) {
          nextConfig = {
            ...nextConfig,
            homeserver: nativeBootstrap.session.homeserver,
            userId: nativeBootstrap.session.userId,
            matrixDeviceId: nativeBootstrap.session.matrixDeviceId,
            accessToken: NATIVE_MANAGED_ACCESS_TOKEN,
          };
        } else {
          const credentials = await loginWithMatrixToken(
            matrixLogin.homeserver,
            matrixLogin.loginToken,
            matrixLogin.userId,
            browserDeviceName(),
          );
          nextConfig = { ...nextConfig, ...credentials };
        }
        setMatrixConfig(nextConfig);
        saveMatrixConfig(nextConfig);
        settleNativeBootstrapTransfer("offline");
      } catch (error) {
        settleNativeBootstrapTransfer("error");
        setConnectionError(
          `The one-time sign-in could not be used: ${formatUiError(error)} Sign in below to continue.`,
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
    setPairingError(null);
    try {
      detachClientForNativeBootstrap();
      const preview = pairingPreview;
      const nativeBootstrap = preview
        ? await bootstrapNativeMatrixSessionIfAvailable({
            homeserver: matrixConfig.homeserver,
            password,
            expectedUserId: userId,
            deviceName: browserDeviceName(),
            roomBinding: {
              roomId: preview.transport.roomId,
              gatewayId: preview.gatewayId,
              conversationId: preview.transport.roomId,
              gatewayUserId: preview.transport.userId,
              gatewayDeviceId: preview.transport.deviceId,
              gatewayDeviceEd25519: preview.transport.ed25519,
            },
          })
        : null;
      const credentials = nativeBootstrap
        ? {
            homeserver: nativeBootstrap.session.homeserver,
            userId: nativeBootstrap.session.userId,
            matrixDeviceId: nativeBootstrap.session.matrixDeviceId,
            accessToken: NATIVE_MANAGED_ACCESS_TOKEN,
          }
        : await loginWithMatrixPassword(
            matrixConfig.homeserver,
            userId,
            password,
            browserDeviceName(),
          );
      const next = { ...matrixConfig, ...credentials };
      setMatrixConfig(next);
      saveMatrixConfig(next);
      // Native bootstrap is opportunistic. A regular browser deliberately
      // falls back to the Web Matrix client, so the temporary transfer state
      // must be settled for both outcomes before pairing can be confirmed.
      settleNativeBootstrapTransfer("offline");
    } catch (error) {
      settleNativeBootstrapTransfer("error");
      setConnectionError(formatUiError(error));
    } finally {
      setPairingBusy(false);
    }
  }

  async function createDeviceInvitation(password?: string) {
    if (!trustedGateway || !codeverClientRef.current) {
      setConnectionError(
        "Connect to your approved computer before adding another device.",
      );
      return;
    }
    const reusable = deviceInvitationLifecycleRef.current.current();
    if (reusable) {
      showDeviceInvitation(reusable);
      return;
    }
    setInvitationBusy(true);
    setInvitationError(null);
    try {
      const generated = await deviceInvitationLifecycleRef.current.request(
        async () => {
          const connection = codeverClientRef.current;
          if (!connection) throw new Error("The connection was closed.");
          let gatewayInvitation = pendingGatewayInvitationRef.current;
          if (
            !gatewayInvitation ||
            gatewayInvitation.expiresAt <= Date.now() + 15_000
          ) {
            matrixLoginTokenLifecycleRef.current.clear();
            pendingGatewayInvitationRef.current = null;
            let completion: CommandCompletion;
            let commandId: string | null = null;
            try {
              try {
                const sent = await sendRealCommand({
                  operation: "device.invite",
                  lifetimeMs: 5 * 60_000,
                });
                if (!sent) {
                  throw new Error(
                    "The invitation request is waiting for revision conflict review.",
                  );
                }
                commandId = sent.commandId;
                completion = await waitForCommandCompletion(
                  sent.completion,
                  DEVICE_INVITATION_RESULT_TIMEOUT_MS,
                );
              } catch (error) {
                if (!(error instanceof CommandAcknowledgementTimeoutError)) {
                  throw error;
                }
                commandId = error.commandId;
                setInvitationError(
                  "Your computer is still preparing this invitation. Codever will keep waiting instead of creating another one.",
                );
                completion = await connection.observeCommandCompletion(
                  error.commandId,
                  DEVICE_INVITATION_RESULT_TIMEOUT_MS,
                );
              }
            } finally {
              if (commandId) {
                completedCommandResultsRef.current.delete(commandId);
              }
            }
            if (completion.outcome !== "succeeded") {
              if (commandId) await connection.releaseCommand(commandId);
              throw new Error(
                "Your computer could not create the device invitation.",
              );
            }
            if (!commandId) {
              throw new Error("The invitation command identity was lost.");
            }
            try {
              gatewayInvitation = {
                commandId,
                ...parseGatewayInvitationResult(completion.result),
              };
            } catch (error) {
              await connection.releaseCommand(commandId);
              throw error;
            }
            pendingGatewayInvitationRef.current = gatewayInvitation;
          }

          // Request the one-time Matrix credential only after the potentially
          // slow Gateway command completes, so queue delay cannot consume most
          // of the credential's useful lifetime.
          const tokenResult =
            await matrixLoginTokenLifecycleRef.current.request({
              invitationId: gatewayInvitation.commandId,
              invitationExpiresAt: gatewayInvitation.expiresAt,
              issue: () =>
                connection.requestMatrixLoginToken(
                  gatewayInvitation.commandId,
                  password,
                ),
              onRateLimit: (remainingMs) => {
                if (remainingMs === 0) {
                  setInvitationError(
                    "The account provider is accepting another sign-in attempt. Finishing this invitation…",
                  );
                  return;
                }
                setInvitationError(
                  `The account provider temporarily limited new-device sign-ins. Codever will keep this invitation and retry in ${Math.ceil(remainingMs / 1_000)} seconds.`,
                );
              },
            });
          if (
            tokenResult.status === "reauth-required" &&
            tokenResult.passwordSupported
          ) {
            setInvitationReauthRequired(true);
            throw new InvitationReauthenticationRequiredError();
          }
          const fullInvitation = createDeviceInvitationLink({
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
          const shortened = await shortenDeviceInvitation(
            fullInvitation,
            window.location.href,
          );
          if (shortened.expiresAt <= Date.now() + 15_000) {
            await connection.releaseCommand(gatewayInvitation.commandId);
            pendingGatewayInvitationRef.current = null;
            matrixLoginTokenLifecycleRef.current.clear();
            throw new Error(
              "The recovered device invitation expired before it could be displayed. Create a new one.",
            );
          }
          await connection.releaseCommand(gatewayInvitation.commandId);
          pendingGatewayInvitationRef.current = null;
          matrixLoginTokenLifecycleRef.current.clear();
          return shortened;
        },
      );
      showDeviceInvitation(generated);
      setInvitationReauthRequired(false);
      setInvitationError(null);
    } catch (error) {
      if (
        !(error instanceof InvitationReauthenticationRequiredError) &&
        !(error instanceof InvitationRequestCancelledError) &&
        !(error instanceof MatrixLoginTokenRequestCancelledError)
      ) {
        setInvitationError(formatUiError(error));
      }
    } finally {
      setInvitationBusy(false);
    }
  }

  function showDeviceInvitation(invitation: GeneratedDeviceInvitation): void {
    if (invitationExpiryTimeoutRef.current !== null) {
      window.clearTimeout(invitationExpiryTimeoutRef.current);
    }
    setDeviceInvitation(invitation);
    invitationExpiryTimeoutRef.current = window.setTimeout(() => {
      invitationExpiryTimeoutRef.current = null;
      deviceInvitationLifecycleRef.current.clear();
      matrixLoginTokenLifecycleRef.current.clear();
      pendingGatewayInvitationRef.current = null;
      setDeviceInvitation(null);
      setInvitationError("This device invitation expired. Create a new one.");
    }, Math.max(0, invitation.expiresAt - Date.now()));
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
    setPairingError(null);
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
      const configForPairing = isNativeManagedMatrixConfig(unresolvedConfig)
        ? normalizeMatrixConfig(unresolvedConfig)
        : await resolveMatrixSession(unresolvedConfig);
      setMatrixConfig(configForPairing);
      const connection = await connectCodeverClient(configForPairing, false);
      if (!connection) return;
      const trust = await connection.pair(
        encodePairingLink(previewOverride.signedOffer),
        browserDeviceName(),
        abort.signal,
      );
      saveMatrixConfig(configForPairing);
      setTrustedGateway(trust);
      setActiveDeviceCount(trust.activeDeviceCount ?? null);
      setMatrixConfig(configForPairing);
      setPairingPreview(null);
      setPairingError(null);
      setSettingsOpen(false);
      showUiNotice(
        "connection:paired",
        "session",
        "success",
        `${trust.gatewayName} connected.`,
        5_000,
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setPairingError(formatUiError(error));
      }
    } finally {
      if (pairingAbortRef.current === abort) pairingAbortRef.current = null;
      setPairingBusy(false);
    }
  }
  pairingRecoveryRef.current = confirmPairing;

  async function sendRealCommand(
    payload: CommandPayload,
  ): Promise<CodeverCommandSendResult | null> {
    const notice = commandNoticeFor(payload);
    const connection = codeverClientRef.current;
    if (!connection || connectionStatus !== "connected") {
      showUiNotice(
        notice.key,
        notice.scope,
        "warning",
        connectionStatus === "reconnecting" || connectionStatus === "connecting"
          ? "The connection is still resuming. Try again when your computer is connected."
          : "Your computer is not connected. Open connection settings.",
      );
      return null;
    }
    try {
      const result = await connection.send(payload);
      revisionConflictRef.current = null;
      recoverUiNotice(notice.key);
      return result;
    } catch (error) {
      if (error instanceof CommandAcknowledgementTimeoutError) throw error;
      if (error instanceof CommandReviewRequiredError) {
        const review: NativeCommandReviewNotice = {
          ...error.review,
          busy: false,
        };
        nativeCommandReviewRef.current = review;
        setNativeCommandReview(review);
        recoverUiNotice(notice.key);
        return null;
      }
      if (isCommandRecoveryPendingError(error)) {
        showUiNotice(
          notice.key,
          notice.scope,
          "warning",
          formatUiError(error),
        );
        return null;
      }
      if (error instanceof CommandRevisionConflictError) {
        const notice: RevisionConflictNotice = {
          commandId: error.commandId,
          expectedRevision: error.expectedRevision,
          payload: error.payload,
          busy: false,
        };
        revisionConflictRef.current = notice;
        setRevisionConflict(notice);
        recoverUiNotice(commandNoticeFor(payload).key);
        return null;
      }
      showUiNotice(
        notice.key,
        notice.scope,
        "error",
        formatUiError(error),
      );
      return null;
    }
  }

  async function consumeSessionCreateCompletion(
    connection: CodeverClient,
    commandId: string,
    completion: CommandCompletion,
  ): Promise<void> {
    let sessionToReveal: string | null = null;
    let skipHistoryRestore = false;
    try {
      completedCommandResultsRef.current.delete(commandId);
      if (completion.outcome !== "succeeded") return;
      if (completion.sessionId) {
        const target = completedSessionCreateTarget(
          completion.sessionId,
          knownGatewaySessionIdsRef.current,
        );
        pendingCreatedSessionIdRef.current = target.pendingSessionId;
        sessionToReveal = target.sessionToReveal;
        skipHistoryRestore = target.skipHistoryRestore;
      }
      setNewSessionOpen(false);
    } finally {
      // Receiving an acknowledgement is not enough for session.create: the
      // terminal sessionId must survive reloads until this UI has consumed it.
      await connection.releaseCommand(commandId);
      forgetPendingSessionCreate(commandId);
    }
    if (sessionToReveal) {
      clearPendingSessionCreateUi();
      activateLocalSession(
        sessionToReveal,
        connection,
        true,
        skipHistoryRestore,
      );
      setMobileChatOpen(true);
    }
  }

  async function waitForRecoverableSessionCreateCompletion(
    connection: CodeverClient,
    sent: CodeverCommandSendResult,
  ): Promise<CommandCompletion> {
    try {
      return await waitForCommandCompletion(
        sent.completion,
        SESSION_CREATE_RESULT_RECOVERY_MS,
      );
    } catch (error) {
      if (!(error instanceof CommandCompletionTimeoutError)) throw error;
      // Recovery is intentionally keyed by the persisted command ID. The
      // connection refuses to reserve a new command if that exact outbox entry
      // is unavailable, so this can never create a second session.
      const recovered = await connection.recoverCommand(sent.commandId);
      return waitForCommandCompletion(recovered.completion);
    }
  }

  async function confirmRevisionRetry() {
    const conflict = revisionConflictRef.current;
    const connection = codeverClientRef.current;
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
            showUiNotice(
              "history:save",
              "history",
              "warning",
              `Conversation history could not be saved: ${formatUiError(error)}`,
            );
          });
        }
      }
      if (conflict.payload.operation === "prompt") {
        const sessionId = conflict.payload.sessionId;
        setPendingFiles([]);
        if (completedCommandResultsRef.current.delete(result.commandId)) {
          finishLocalPromptCommand(sessionId);
        } else {
          activePromptCommandsRef.current.set(result.commandId, sessionId);
          setSessionRunning(sessionId, true);
          setSessionAgentActivity(
            sessionId,
            runningSessionIds.has(sessionId)
              ? WORKING_AGENT_ACTIVITY
              : STARTING_AGENT_ACTIVITY,
          );
        }
      }
      const completion =
        conflict.payload.operation === "prompt"
          ? null
          : conflict.payload.operation === "session.create"
            ? await waitForRecoverableSessionCreateCompletion(
                connection,
                result,
              )
            : await result.completion;
      if (
        completion &&
        conflict.payload.operation === "session.create"
      ) {
        await consumeSessionCreateCompletion(
          connection,
          result.commandId,
          completion,
        );
      } else if (
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
      showUiNotice(
        "composer:revision-retry",
        "composer",
        "error",
        formatUiError(error),
      );
    }
  }

  async function discardRevisionConflict() {
    const conflict = revisionConflictRef.current;
    const connection = codeverClientRef.current;
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
      showUiNotice(
        "composer:revision-discard",
        "composer",
        "error",
        formatUiError(error),
      );
    }
  }

  async function retryNativeCommandReview() {
    const review = nativeCommandReviewRef.current;
    const connection = codeverClientRef.current;
    if (!review || !connection || review.busy) return;
    const busyReview = { ...review, busy: true };
    nativeCommandReviewRef.current = busyReview;
    setNativeCommandReview(busyReview);
    try {
      const sent = await connection.confirmRevisionRetry(review.commandId);
      if (nativeCommandReviewRef.current?.commandId === review.commandId) {
        nativeCommandReviewRef.current = null;
        setNativeCommandReview(null);
      }
      void sent.completion
        .then(() => connection.releaseCommand(sent.commandId))
        .catch((error) => {
          showUiNotice(
            "command:review-retry",
            "composer",
            "warning",
            `The retried action is still being reconciled: ${formatUiError(error)}`,
          );
        });
    } catch (error) {
      if (error instanceof CommandReviewRequiredError) {
        const next: NativeCommandReviewNotice = {
          ...error.review,
          busy: false,
        };
        nativeCommandReviewRef.current = next;
        setNativeCommandReview(next);
        return;
      }
      const next = { ...review, busy: false };
      nativeCommandReviewRef.current = next;
      setNativeCommandReview(next);
      showUiNotice(
        "command:review-retry",
        "composer",
        "error",
        formatUiError(error),
      );
    }
  }

  async function discardNativeCommandReview() {
    const review = nativeCommandReviewRef.current;
    const connection = codeverClientRef.current;
    if (!review || !connection || review.busy) return;
    const busyReview = { ...review, busy: true };
    nativeCommandReviewRef.current = busyReview;
    setNativeCommandReview(busyReview);
    try {
      await connection.discardRevisionConflict(review.commandId);
      if (nativeCommandReviewRef.current?.commandId === review.commandId) {
        nativeCommandReviewRef.current = null;
        setNativeCommandReview(null);
      }
    } catch (error) {
      const next = { ...review, busy: false };
      nativeCommandReviewRef.current = next;
      setNativeCommandReview(next);
      showUiNotice(
        "command:review-discard",
        "composer",
        "error",
        formatUiError(error),
      );
    }
  }

  function chooseSession(id: string) {
    setMobileChatOpen(true);
    activateLocalSession(id);
  }

  async function createSession(input: NewSessionInput) {
    if (!gatewayState?.capabilities.canCreateSession) {
      showUiNotice(
        "session:create",
        "session",
        "warning",
        gatewayState
          ? "This computer does not support creating sessions."
          : "Waiting for your conversations to sync.",
      );
      return;
    }
    setSessionCreateReloadBlocked(true);
    setNewSessionBusy(true);
    setPendingSessionCreate(input);
    setNewSessionOpen(false);
    setMobileChatOpen(false);
    recoverUiNotice("session:create");
    let durableCommandRecorded = false;
    let connection: CodeverClient | null = null;
    try {
      // Let React commit the pending row before Matrix encryption, IndexedDB,
      // acknowledgement, and command-result work begins.
      await waitForUiCommit();
      connection = codeverClientRef.current;
      const sent = await sendRealCommand({
        operation: "session.create",
        cwd: input.cwd,
        projectName: input.projectName,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
        ...(input.extensions?.length ? { extensions: input.extensions } : {}),
      });
      if (!sent || !connection) return;
      rememberPendingSessionCreate(input, sent.commandId);
      durableCommandRecorded = true;
      continuePendingSessionCreate(connection, sent);
    } catch (error) {
      if (error instanceof CommandAcknowledgementTimeoutError && connection) {
        rememberPendingSessionCreate(input, error.commandId);
        durableCommandRecorded = true;
        showUiNotice(
          "session:create",
          "session",
          "warning",
          "Session creation is queued securely. Codever will resume this same command without creating a duplicate.",
        );
        continuePendingSessionCreate(connection);
      } else {
        showUiNotice(
          "session:create",
          "session",
          "error",
          formatUiError(error),
        );
      }
    } finally {
      if (!durableCommandRecorded) clearPendingSessionCreateUi();
    }
  }

  async function settleSessionCreate(
    connection: CodeverClient,
    sent: CodeverCommandSendResult,
  ): Promise<void> {
    let waitingForGatewayState = false;
    try {
      const completion = await waitForRecoverableSessionCreateCompletion(
        connection,
        sent,
      );
      if (completion.outcome !== "succeeded") {
        showUiNotice(
          "session:create",
          "session",
          "error",
          "Your computer could not create the session.",
        );
      }
      await consumeSessionCreateCompletion(
        connection,
        sent.commandId,
        completion,
      );
      waitingForGatewayState =
        completion.outcome === "succeeded" && Boolean(completion.sessionId);
      if (waitingForGatewayState) recoverUiNotice("session:create");
    } catch (error) {
      if (
        pendingSessionCreateRecoveryRef.current?.commandId === sent.commandId
      ) {
        throw error;
      }
      showUiNotice(
        "session:create",
        "session",
        "error",
        formatUiError(error),
      );
    } finally {
      if (
        !waitingForGatewayState &&
        pendingSessionCreateRecoveryRef.current?.commandId !== sent.commandId
      ) {
        clearPendingSessionCreateUi();
      }
    }
  }

  async function runSessionLifecycle(
    action: "archive" | "restore" | "delete",
    sessionId: string,
    onSucceeded?: () => void | Promise<void>,
    onFailed?: () => void | Promise<void>,
  ): Promise<boolean> {
    const capabilities = gatewayState?.capabilities;
    const supported =
      action === "delete"
        ? capabilities?.canDeleteSession
        : capabilities?.canArchiveSession;
    if (!supported) {
      showUiNotice(
        `session:${action}`,
        "session",
        "warning",
        `This computer does not support session ${action}. Update Codever on the computer and reconnect first.`,
      );
      return false;
    }
    setSessionLifecycleBusy((current) => {
      const next = new Map(current);
      next.set(sessionId, action);
      return next;
    });
    let connection: CodeverClient | null = null;
    try {
      connection = codeverClientRef.current;
      const sent = await sendRealCommand(
        sessionLifecyclePayload(action, sessionId),
      );
      if (!sent || !connection) {
        setSessionLifecycleBusy((current) => {
          if (current.get(sessionId) !== action) return current;
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        });
        return false;
      }
      setDetailsOpen(false);
      void settleSessionLifecycle(
        connection,
        sent,
        action,
        sessionId,
        onSucceeded,
        onFailed,
      );
      return true;
    } catch (error) {
      if (error instanceof CommandAcknowledgementTimeoutError && connection) {
        const recovery: PendingSessionLifecycleRecovery = {
          commandId: error.commandId,
          action,
          sessionId,
          ...(onSucceeded ? { onSucceeded } : {}),
          ...(onFailed ? { onFailed } : {}),
          timer: null,
          inFlight: false,
        };
        sessionLifecycleRecoveriesRef.current.set(error.commandId, recovery);
        setDetailsOpen(false);
        showUiNotice(
          `session:${action}`,
          "session",
          "warning",
          formatUiError(error),
        );
        continueSessionLifecycleRecovery(recovery);
        return true;
      }
      showUiNotice(
        `session:${action}`,
        "session",
        "error",
        formatUiError(error),
      );
      setSessionLifecycleBusy((current) => {
        if (current.get(sessionId) !== action) return current;
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });
      return false;
    }
  }

  function clearSessionLifecycleRecoveries(): void {
    for (const recovery of sessionLifecycleRecoveriesRef.current.values()) {
      if (recovery.timer !== null) window.clearTimeout(recovery.timer);
    }
    sessionLifecycleRecoveriesRef.current.clear();
  }

  function scheduleSessionLifecycleRecovery(
    recovery: PendingSessionLifecycleRecovery,
  ): void {
    if (
      sessionLifecycleRecoveriesRef.current.get(recovery.commandId) !== recovery
    ) return;
    if (recovery.timer !== null) window.clearTimeout(recovery.timer);
    recovery.timer = window.setTimeout(() => {
      recovery.timer = null;
      continueSessionLifecycleRecovery(recovery);
    }, 5_000);
  }

  function continueSessionLifecycleRecovery(
    recovery: PendingSessionLifecycleRecovery,
  ): void {
    if (
      recovery.inFlight ||
      sessionLifecycleRecoveriesRef.current.get(recovery.commandId) !== recovery
    ) return;
    const connection = codeverClientRef.current;
    if (!connection || connectionStatusRef.current !== "connected") {
      scheduleSessionLifecycleRecovery(recovery);
      return;
    }
    recovery.inFlight = true;
    void (async () => {
      try {
        const sent = await connection.recoverCommand(recovery.commandId);
        if (
          sessionLifecycleRecoveriesRef.current.get(recovery.commandId) !==
          recovery
        ) return;
        sessionLifecycleRecoveriesRef.current.delete(recovery.commandId);
        recoverUiNotice(`session:${recovery.action}`);
        await settleSessionLifecycle(
          connection,
          sent,
          recovery.action,
          recovery.sessionId,
          recovery.onSucceeded,
          recovery.onFailed,
        );
      } catch (error) {
        if (
          sessionLifecycleRecoveriesRef.current.get(recovery.commandId) !==
          recovery
        ) return;
        if (
          error instanceof CommandAcknowledgementTimeoutError ||
          isCommandRecoveryPendingError(error) ||
          connectionStatusRef.current !== "connected"
        ) {
          showUiNotice(
            `session:${recovery.action}`,
            "session",
            "warning",
            "Your computer did not confirm this command. It remains queued for a safe retry.",
          );
          scheduleSessionLifecycleRecovery(recovery);
          return;
        }
        sessionLifecycleRecoveriesRef.current.delete(recovery.commandId);
        await recovery.onFailed?.();
        showUiNotice(
          `session:${recovery.action}`,
          "session",
          "error",
          formatUiError(error),
        );
        setSessionLifecycleBusy((current) => {
          if (current.get(recovery.sessionId) !== recovery.action) return current;
          const next = new Map(current);
          next.delete(recovery.sessionId);
          return next;
        });
      } finally {
        recovery.inFlight = false;
      }
    })();
  }

  async function settleSessionLifecycle(
    connection: CodeverClient,
    sent: CodeverCommandSendResult,
    action: "archive" | "restore" | "delete",
    sessionId: string,
    onSucceeded?: () => void | Promise<void>,
    onFailed?: () => void | Promise<void>,
  ): Promise<void> {
    try {
      const completion = await waitForCommandCompletion(sent.completion);
      if (completion.outcome !== "succeeded") {
        await onFailed?.();
        showUiNotice(
          `session:${action}`,
          "session",
          "error",
          `The session could not be ${lifecyclePastTense(action)}.`,
        );
        return;
      }
      await onSucceeded?.();
      recoverUiNotice(`session:${action}`);
    } catch (error) {
      await onFailed?.();
      showUiNotice(
        `session:${action}`,
        "session",
        "error",
        formatUiError(error),
      );
    } finally {
      try {
        await connection.releaseCommand(sent.commandId);
      } catch (error) {
        showUiNotice(
          `session:${action}:release`,
          "session",
          "warning",
          `The completed session command could not be released locally: ${formatUiError(error)}`,
        );
      }
      setSessionLifecycleBusy((current) => {
        if (current.get(sessionId) !== action) return current;
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function archiveSession(sessionId: string) {
    await runSessionLifecycle("archive", sessionId);
  }

  async function restoreSession(sessionId: string) {
    if (await runSessionLifecycle("restore", sessionId)) {
      setMobileChatOpen(true);
      activateLocalSession(sessionId);
    }
  }

  async function deleteSession() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setDetailsOpen(false);
    pendingDeletionSessionIdsRef.current = setSessionDeletionPending(
      pendingDeletionSessionIdsRef.current,
      target.id,
      true,
    );
    if (selectedSessionIdRef.current === target.id) {
      activateLocalSession(null);
      setMobileChatOpen(false);
    }
    const restoreSelection = () => {
      pendingDeletionSessionIdsRef.current = setSessionDeletionPending(
        pendingDeletionSessionIdsRef.current,
        target.id,
        false,
      );
      activateLocalSession(target.id);
      setMobileChatOpen(true);
    };
    const acknowledged = await runSessionLifecycle(
      "delete",
      target.id,
      async () => {
        liveMessagesBySessionRef.current.delete(target.id);
        knownGatewaySessionIdsRef.current.delete(target.id);
        if (historyScopeRef.current) {
          try {
            await clearSessionMessageHistory(historyScopeRef.current, target.id);
          } catch (error) {
            showUiNotice(
              "history:deleted-session-cleanup",
              "history",
              "warning",
              `The session was deleted, but its local history could not be cleared: ${formatUiError(error)}`,
            );
          }
        }
      },
      restoreSelection,
    );
    if (!acknowledged) restoreSelection();
  }

  function selectAttachments(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = [...(event.target.files ?? [])];
    event.target.value = "";
    if (selectedFiles.length === 0) return;
    const availableSlots = MAX_CODEVER_ATTACHMENTS - pendingFiles.length;
    if (availableSlots <= 0) {
      showUiNotice(
        "attachment:limits",
        "attachment",
        "warning",
        `A message can include up to ${MAX_CODEVER_ATTACHMENTS} attachments.`,
      );
      return;
    }
    const accepted: File[] = [];
    let totalBytes = pendingFiles.reduce((total, file) => total + file.size, 0);
    for (const file of selectedFiles.slice(0, availableSlots)) {
      if (file.size > MAX_CODEVER_ATTACHMENT_BYTES) {
        showUiNotice(
          "attachment:limits",
          "attachment",
          "warning",
          `${file.name} exceeds the ${formatFileSize(MAX_CODEVER_ATTACHMENT_BYTES)} attachment limit.`,
        );
        continue;
      }
      if (totalBytes + file.size > MAX_CODEVER_PROMPT_ATTACHMENT_BYTES) {
        showUiNotice(
          "attachment:limits",
          "attachment",
          "warning",
          `Attachments in one message cannot exceed ${formatFileSize(MAX_CODEVER_PROMPT_ATTACHMENT_BYTES)}.`,
        );
        continue;
      }
      accepted.push(file);
      totalBytes += file.size;
    }
    if (selectedFiles.length > availableSlots) {
      showUiNotice(
        "attachment:limits",
        "attachment",
        "warning",
        `Only the first ${availableSlots} selected attachment(s) were added.`,
      );
    }
    if (accepted.length > 0) recoverUiNotice("attachment:upload");
    setPendingFiles((current) => [...current, ...accepted]);
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const value = draft.trim();
    if (!value && pendingFiles.length === 0) return;
    const sessionId = selectedSessionIdRef.current;
    if (!composerState.canSend || !sessionId) {
      showUiNotice(
        "composer:availability",
        "composer",
        "warning",
        composerState.reason,
      );
      return;
    }
    if (pendingPromptSessionIdsRef.current.has(sessionId)) {
      showUiNotice(
        "composer:availability",
        "composer",
        "info",
        "Securing the previous message…",
      );
      return;
    }
    const connection = codeverClientRef.current;
    if (!connection) {
      showUiNotice(
        "composer:availability",
        "composer",
        "warning",
        "The secure connection is not ready yet. Your draft is still here.",
      );
      return;
    }
    recoverUiNotice("composer:availability");
    const queueBehindActiveTurn = isStreaming;
    const activityBeforeSubmission = agentActivity;
    const submittedFiles = [...pendingFiles];
    let attachments: CodeverAttachment[] | undefined;
    if (submittedFiles.length > 0) {
      setAttachmentBusy(true);
      setSessionAgentActivity(sessionId, {
        phase: "sending",
        label: "Encrypting attachments",
        detail: `${submittedFiles.length} file${submittedFiles.length === 1 ? "" : "s"}`,
      });
      try {
        attachments = await Promise.all(
          submittedFiles.map((file) => connection.uploadAttachment(file)),
        );
        recoverUiNotice("attachment:upload");
      } catch (error) {
        showUiNotice(
          "attachment:upload",
          "attachment",
          "error",
          `Attachment upload failed: ${formatUiError(error)}`,
        );
        setSessionAgentActivity(sessionId, activityBeforeSubmission);
        return;
      } finally {
        setAttachmentBusy(false);
      }
    }
    const submissionHistoryScope = historyScopeRef.current;
    const submissionOriginDeviceId = deviceKeyId ?? undefined;
    const submissionOriginDeviceName = connection.deviceName;
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
      attachments,
    };
    const optimisticHistoryPersisted = submissionHistoryScope
      ? saveMessageHistory(
        submissionHistoryScope,
        sessionId,
        [optimisticMessage],
      ).catch((error) => {
        showUiNotice(
          "history:save",
          "history",
          "warning",
          `Conversation history could not be saved: ${formatUiError(error)}`,
        );
        throw error;
      })
      : Promise.resolve();
    setSessionPromptSubmitting(sessionId, true);
    let result: CodeverCommandSendResult | null;
    let acknowledgementTimeout: CommandAcknowledgementTimeoutError | null = null;
    try {
      // Visibility is the durability boundary: once the user can see the
      // optimistic message, an immediate reload/background transition must be
      // able to restore it without waiting for Matrix history pagination.
      await optimisticHistoryPersisted;
      optimisticMessagesRef.current.set(optimisticId, {
        id: optimisticId,
        text: value,
        sessionId: optimisticMessage.sessionId,
      });
      rememberLiveMessage(sessionId, optimisticMessage);
      if (selectedSessionIdRef.current === sessionId) {
        followLatestRef.current = true;
        setMessages((current) => [...current, optimisticMessage]);
        setDraft("");
      }
      setSessionRunning(sessionId, true);
      if (!queueBehindActiveTurn) {
        setSessionAgentActivity(sessionId, SENDING_AGENT_ACTIVITY);
      }
      result = await sendRealCommand(
        createPromptCommandPayload({
          sessionId,
          text: value,
          attachments,
        }),
      );
    } catch (error) {
      if (!(error instanceof CommandAcknowledgementTimeoutError)) throw error;
      acknowledgementTimeout = error;
      result = null;
    } finally {
      setSessionPromptSubmitting(sessionId, false);
    }
    if (acknowledgementTimeout) {
      const optimisticReference =
        optimisticMessagesRef.current.get(optimisticId);
      if (optimisticReference) {
        optimisticReference.commandId = acknowledgementTimeout.commandId;
      }
      if (
        completedCommandResultsRef.current.delete(
          acknowledgementTimeout.commandId,
        )
      ) {
        finishLocalPromptCommand(sessionId);
      } else {
        activePromptCommandsRef.current.set(
          acknowledgementTimeout.commandId,
          sessionId,
        );
        setSessionAgentActivity(
          sessionId,
          queueBehindActiveTurn
            ? activityBeforeSubmission ?? WORKING_AGENT_ACTIVITY
            : STARTING_AGENT_ACTIVITY,
        );
      }
      setPendingFiles([]);
      showUiNotice(
        "composer:send",
        "composer",
        "warning",
        gatewayLiveness.state === "offline"
          ? "Your computer's Codever Gateway is offline. This message is saved for reconciliation and has not been submitted again."
          : "Your computer did not acknowledge this message. It is saved for reconciliation; do not send it again while Codever determines whether it ran.",
      );
      return;
    }
    if (!result) {
      finishLocalPromptCommand(sessionId);
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
              showUiNotice(
                "history:update",
                "history",
                "warning",
                `Conversation history could not be updated: ${formatUiError(error)}`,
              );
            });
          }
          if (selectedSessionIdRef.current === sessionId) {
            setDraft(value);
          }
        }
      } else if (nativeCommandReviewRef.current) {
        // The native outbox is asking the user to resolve an earlier,
        // state-dependent action. This prompt was not accepted, but that is
        // neither an Agent error nor a broken connection. Remove the
        // optimistic copy and restore the exact draft instead of adding the
        // misleading TASK NEEDS ATTENTION / connection-settings message.
        optimisticMessagesRef.current.delete(optimisticId);
        removeLiveMessage(sessionId, optimisticId);
        if (selectedSessionIdRef.current === sessionId) {
          setMessages((current) =>
            current.filter((message) => message.id !== optimisticId),
          );
          setDraft(value);
        }
        if (submissionHistoryScope) {
          void deleteMessageHistory(
            submissionHistoryScope,
            optimisticId,
          ).catch((error) => {
            showUiNotice(
              "history:update",
              "history",
              "warning",
              `Conversation history could not be updated: ${formatUiError(error)}`,
            );
          });
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
            showUiNotice(
              "history:save",
              "history",
              "warning",
              `Conversation history could not be saved: ${formatUiError(error)}`,
            );
          });
        }
        const errorMessage: ChatMessage = {
          id: `matrix-error-${Date.now()}`,
          kind: "error",
          text: "The command was not sent. Open connection settings.",
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
        finishLocalPromptCommand(sessionId);
      } else {
        activePromptCommandsRef.current.set(result.commandId, sessionId);
        setSessionAgentActivity(
          sessionId,
          queueBehindActiveTurn
            ? activityBeforeSubmission ?? WORKING_AGENT_ACTIVITY
            : STARTING_AGENT_ACTIVITY,
        );
      }
      const sentMessage: ChatMessage = {
        ...optimisticMessage,
        commandId: result.commandId,
        revision: result.revision,
        originDeviceId: submissionOriginDeviceId,
        originDeviceName: submissionOriginDeviceName,
        deliveryState: "sent",
      };
      setPendingFiles([]);
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
          showUiNotice(
            "history:save",
            "history",
            "warning",
            `Conversation history could not be saved: ${formatUiError(error)}`,
          );
        });
      }
      recoverUiNotice("composer:send");
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && composerOptionsOpen) {
      event.preventDefault();
      setComposerOptionsOpen(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function restoreFailedMessage(message: ChatMessage) {
    const sessionId = message.sessionId ?? selectedSessionIdRef.current;
    if (!sessionId || !message.text) return;
    if (draft.trim()) {
      showUiNotice(
        "composer:retry",
        "composer",
        "warning",
        "Your current draft is still here. Send or clear it before restoring the failed message.",
      );
      composerTextareaRef.current?.focus();
      return;
    }
    setDraft(message.text);
    optimisticMessagesRef.current.delete(message.id);
    removeLiveMessage(sessionId, message.id);
    setMessages((current) =>
      current.filter((entry) => entry.id !== message.id),
    );
    if (historyScopeRef.current) {
      void deleteMessageHistory(historyScopeRef.current, message.id).catch(
        (error) => {
          showUiNotice(
            "history:update",
            "history",
            "warning",
            `Conversation history could not be updated: ${formatUiError(error)}`,
          );
        },
      );
    }
    if (message.attachments?.length) {
      showUiNotice(
        "composer:retry-attachments",
        "attachment",
        "warning",
        "The message text was restored. Attach its files again before sending.",
      );
    } else {
      recoverUiNotice("composer:retry");
    }
    window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
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
      showUiNotice(
        "composer:permission",
        "composer",
        "error",
        "This permission request is missing its secure request ID.",
      );
      return;
    }
    const sessionId = message.sessionId ?? selectedSessionIdRef.current;
    if (!sessionId) {
      showUiNotice(
        "composer:permission",
        "composer",
        "error",
        "This permission request has no session identity.",
      );
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
          <div className="rail-button active" aria-current="page">
            <Icon>◫</Icon>
            <span>Chats</span>
          </div>
        </nav>
        <div className="rail-spacer" />
        <button
          type="button"
          className="rail-button"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon>⚙</Icon>
          <span>Settings</span>
        </button>
      </aside>

      <section className="session-panel" aria-label="Conversations">
        <header className="session-header">
          <div>
            <span className="eyebrow">Workspace</span>
            <h1>Codever</h1>
          </div>
          <div className="session-header-actions">
            <button
              type="button"
              className="mobile-search-button"
              aria-label={sessionSearchOpen ? "Close conversation search" : "Search conversations"}
              aria-expanded={sessionSearchOpen}
              aria-controls="session-search"
              onClick={() => {
                if (sessionSearchOpen) {
                  setSearch("");
                  setSessionSearchOpen(false);
                  return;
                }
                setSessionSearchOpen(true);
                window.requestAnimationFrame(() =>
                  sessionSearchRef.current?.focus(),
                );
              }}
            >
              {sessionSearchOpen ? "×" : "⌕"}
            </button>
            <button
              className="round-button"
              aria-label="New conversation"
              onClick={() => setNewSessionOpen(true)}
              disabled={
                newSessionBusy ||
                !gatewayAvailable ||
                !gatewayState?.capabilities.canCreateSession
              }
            >
              +
            </button>
          </div>
        </header>

        <label
          className={`search-box ${sessionSearchOpen || search ? "search-box-open" : ""}`}
        >
          <span aria-hidden="true">⌕</span>
          <input
            id="session-search"
            ref={sessionSearchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
          <kbd aria-label="Control or Command K">Ctrl/⌘ K</kbd>
        </label>

        <button
          className={`gateway-card gateway-card-button connection-state-${displayedConnectionStatus} ${
            displayedConnectionStatus === "offline" || displayedConnectionStatus === "error"
              ? "offline"
              : ""
          }`}
          aria-label={`Open connection settings, ${
            trustedGateway ? connectionPresentation.title : "not connected"
          }`}
          onClick={() => setSettingsOpen(true)}
        >
          <span className="gateway-icon">G</span>
          <div>
            <strong>
              {trustedGateway?.gatewayName || "Connect a computer"}
            </strong>
            <span className="gateway-status-copy">
              <i
                className={`connection-dot connection-state-${displayedConnectionStatus}`}
              />{" "}
              {trustedGateway
                ? connectionPresentation.title
                : "Scan or paste a one-time code"}
            </span>
            <span className="gateway-mobile-status" aria-hidden="true">
              <i
                className={`connection-dot connection-state-${displayedConnectionStatus}`}
              />{" "}
              {trustedGateway ? connectionPresentation.title : "Connect"}
            </span>
          </div>
          <span className="gateway-more" aria-hidden="true">•••</span>
        </button>

        <UiNoticeList
          notices={sessionNotices}
          className="session-notices"
          onDismiss={dismissUiNotice}
        />

        <div className="session-list">
          {pendingSessionCreate && (
            <div
              className="session-row session-create-pending"
              role="status"
              aria-live="polite"
            >
              <span className="session-avatar violet" aria-hidden="true">
                <i className="session-create-spinner" />
              </span>
              <span className="session-copy">
                <span className="session-title-line">
                  <strong>
                    {gatewayAvailable
                      ? "Creating session…"
                      : "Session queued…"}
                  </strong>
                  <time>
                    {gatewayAvailable ? "now" : "waiting"}
                  </time>
                </span>
                <span className="session-preview-line">
                  <span>
                    {pendingSessionCreate.projectName}
                    {pendingSessionCreate.model
                      ? ` · ${pendingSessionCreate.model}`
                      : ""}
                  </span>
                </span>
              </span>
            </div>
          )}
          {projectGroups.map((project) => {
            const expanded = isProjectExpanded({
              state: collapsedProjects,
              projectKey: project.key,
              searchQuery: search,
            });
            const projectSummary = summarizeProjectSessions(
              project.sessions,
              sessionReadState,
            );
            const contentId = `project-sessions-${encodeURIComponent(project.key)}`;
            return (
            <section className="project-session-group" key={project.key}>
              <button
                type="button"
                className="project-session-toggle"
                aria-expanded={expanded}
                aria-controls={contentId}
                aria-label={`${projectSessionSummaryLabel(
                  project.projectName,
                  projectSummary,
                )}. ${expanded ? "Collapse project" : "Expand project"}`}
                onClick={() =>
                  setCollapsedProjects((current) =>
                    toggleProjectCollapsed(current, project.key),
                  )
                }
              >
                <span className="project-chevron" aria-hidden="true">
                  {expanded ? "⌄" : "›"}
                </span>
                <span className="project-folder" aria-hidden="true">▱</span>
                <span className="project-copy">
                  <strong>{project.projectName}</strong>
                  <small>{project.cwd}</small>
                </span>
                <span className="project-indicators" aria-hidden="true">
                  {projectSummary.needsUser > 0 && (
                    <i className="project-needs-user">
                      <span>●</span>
                      <b>{projectSummary.needsUser}</b>
                    </i>
                  )}
                  {projectSummary.working > 0 && (
                    <i className="project-working">
                      <span />
                      <b>{projectSummary.working}</b>
                    </i>
                  )}
                </span>
                <b aria-hidden="true">{project.sessions.length}</b>
              </button>
              {expanded && (
                <div id={contentId} className="project-session-list">
              {project.sessions.map((session) => {
                const indicator = sessionIndicator(session, sessionReadState);
                const signal = sessionListSignal(session, sessionReadState);
                const activity = agentActivitiesBySession.get(session.id);
                const lifecycleAction =
                  sessionLifecycleBusy.get(session.id) ?? null;
                const statusSummary = lifecycleAction
                  ? `${lifecycleAction === "delete" ? "Deleting" : lifecycleAction === "archive" ? "Archiving" : "Restoring"}…`
                  : activity?.detail ||
                    activity?.label ||
                    sessionSignalLabel(signal);
                return (
                <button
                  key={session.id}
                  data-session-id={session.id}
                  data-project-name={session.projectName}
                  aria-pressed={selectedSessionId === session.id}
                  className={`session-row ${
                    selectedSessionId === session.id
                      ? "selected"
                      : ""
                  } session-state-${indicator.activity} session-signal-${signal} ${indicator.unread ? "unread" : ""} ${lifecycleAction ? "is-busy" : ""}`}
                  onClick={() => void chooseSession(session.id)}
                  disabled={lifecycleAction === "delete"}
                >
                  <span className="session-avatar violet">
                    {sessionInitials(session.title)}
                    {signal === "working" && (
                      <i
                        className={`agent-active ${gatewayConnected ? "" : "is-paused"}`}
                        aria-hidden="true"
                      />
                    )}
                    {signal === "ready" && (
                      <i className="agent-ready" aria-hidden="true" />
                    )}
                    {signal === "failed" && (
                      <i className="agent-failed" aria-hidden="true">!</i>
                    )}
                  </span>
                  <span className="session-copy">
                    <span className="session-title-line">
                      <strong>{session.title}</strong>
                      <time>{formatSessionTime(session.updatedAt)}</time>
                    </span>
                    <span className="session-preview-line">
                      {statusSummary ? (
                        <span className="session-status-summary">
                          {statusSummary}
                        </span>
                      ) : (
                        <span className="session-technical-summary">
                          {session.provider}
                          {session.model ? ` · ${session.model}` : ""}
                          {session.reasoningEffort
                            ? ` · ${session.reasoningEffort}`
                            : ""}
                        </span>
                      )}
                      {session.extensions.length > 0 && (
                        <b
                          className="session-extension-badge"
                          title={session.extensions.map((item) => item.name).join(", ")}
                        >
                          ◇ {session.extensions[0]?.name}
                          {session.extensions.length > 1
                            ? ` +${session.extensions.length - 1}`
                            : ""}
                        </b>
                      )}
                    </span>
                  </span>
                </button>
                );
              })}
                </div>
              )}
            </section>
            );
          })}
          {archivedSessionCount > 0 && (
            <section className="archived-session-section">
              <button
                type="button"
                className="archived-session-toggle"
                aria-expanded={archivedOpen || Boolean(search.trim())}
                onClick={() => setArchivedOpen((value) => !value)}
              >
                <span className="archive-mark" aria-hidden="true">▣</span>
                <span>Archived</span>
                <b>{archivedSessionCount}</b>
                <span className="archive-chevron" aria-hidden="true">
                  {archivedOpen || search.trim() ? "⌃" : "⌄"}
                </span>
              </button>
              {(archivedOpen || Boolean(search.trim())) && (
                <div className="archived-session-list">
                  {archivedFilteredSessions.map((session) => (
                    <button
                      type="button"
                      key={session.id}
                      data-session-id={session.id}
                      data-project-name={session.projectName}
                      aria-pressed={selectedSessionId === session.id}
                      className={`archived-session-row ${
                        selectedSessionId === session.id ? "selected" : ""
                      }`}
                      onClick={() => void chooseSession(session.id)}
                    >
                      <span className="archived-session-icon" aria-hidden="true">
                        ▣
                      </span>
                      <span>
                        <strong>{session.title}</strong>
                        <small>
                          {session.projectName} · {session.provider}
                          {session.extensions.length > 0
                            ? ` · ${session.extensions.map((item) => item.name).join(", ")}`
                            : ""}
                        </small>
                      </span>
                      <time>{formatSessionTime(session.updatedAt)}</time>
                    </button>
                  ))}
                  {archivedFilteredSessions.length === 0 && search.trim() && (
                    <small className="archived-empty">No archived matches</small>
                  )}
                </div>
              )}
            </section>
          )}
          {!trustedGateway && (
            <div className="empty-search">
              <span>G</span>
              Connect a computer to start your first conversation
            </div>
          )}
          {trustedGateway && !gatewayState && (
            <div
              className={`empty-search connection-progress connection-progress-${connectionPresentation.state}`}
              role="status"
            >
              {connectionPresentation.state === "progress" ||
              connectionPresentation.state === "ready" ? (
                <span
                  className="connection-progress-spinner"
                  aria-hidden="true"
                />
              ) : (
                <span className="connection-progress-symbol" aria-hidden="true">
                  {connectionPresentation.state === "offline" ? "⌁" : "!"}
                </span>
              )}
              <strong>
                {connectionStatus === "connected"
                  ? "Syncing your conversations"
                  : connectionPresentation.title}
              </strong>
              <small>{connectionPresentation.detail}</small>
              <button type="button" onClick={() => setSettingsOpen(true)}>
                Open connection settings
              </button>
            </div>
          )}
          {gatewayState &&
            activeSessionCount > 0 &&
            projectGroups.length === 0 &&
            Boolean(search.trim()) && (
            <div className="empty-search">
              <span>⌕</span>
              No matching active conversations
            </div>
          )}
          {gatewayState &&
            gatewayState.sessions.length === 0 &&
            !pendingSessionCreate && (
              <div className="empty-search">
                <span>+</span>
                Create your first conversation
              </div>
            )}
          {gatewayState &&
            activeSessionCount === 0 &&
            archivedSessionCount > 0 &&
            !search.trim() && (
              <div className="empty-search compact-empty">
                <span>＋</span>
                No active conversations
              </div>
            )}
        </div>

        <footer className="trust-footer">
          <span className="shield">✓</span>
          <span>
            <strong>Protected connection</strong>
            <small>
              {deviceKeyId
                ? `${connectionPresentation.title} · ${
                    activeDeviceCount === null
                      ? "checking approved devices"
                      : `${activeDeviceCount} approved ${
                          activeDeviceCount === 1 ? "device" : "devices"
                        }`
                  }`
                : "Preparing this device"}
            </small>
          </span>
          <button
            aria-label="Open connection settings"
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
                className={`connection-dot connection-state-${displayedConnectionStatus} ${
                  displayedConnectionStatus === "offline" || displayedConnectionStatus === "error"
                    ? "offline-dot"
                    : ""
                }`}
              />{" "}
              {gatewayAvailable
                ? gatewayState
                  ? selectedArchived
                    ? `${activeWorkspace?.projectName || "Project"} · archived`
                    : `${activeWorkspace?.projectName || "Project"} · ${
                        isStreaming
                          ? agentActivity?.label || "working"
                          : activeProvider
                      }`
                  : "Syncing conversations…"
                : connectionPresentation.title}
            </span>
          </div>
          <div className="header-actions">
            <button
              ref={detailsButtonRef}
              className={`header-button ${detailsOpen ? "pressed" : ""}`}
              aria-label="Conversation details"
              aria-controls="conversation-details-popover"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((value) => !value)}
            >
              ⋯
            </button>
          </div>
        </header>

        <UiNoticeList
          notices={sessionNotices}
          className="session-notices-conversation"
          onDismiss={dismissUiNotice}
        />

        {detailsOpen && (
          <div
            ref={detailsPopoverRef}
            id="conversation-details-popover"
            className="details-popover"
            role="dialog"
            aria-label="Conversation details"
          >
            <span className="mini-label">Project</span>
            <strong>
              {activeWorkspace?.projectName || "Syncing…"}
            </strong>
            <code>{activeWorkspace?.cwd || "Syncing…"}</code>
            <span className="mini-label">Agent</span>
            <strong>{activeProvider}</strong>
            {activeWorkspace?.model && <code>{activeWorkspace.model}</code>}
            {selected?.extensions.length ? (
              <>
                <span className="mini-label">Session extensions</span>
                <div className="details-extension-list">
                  {selected.extensions.map((extension) => (
                    <span key={extension.id}>◇ {extension.name} · v{extension.version}</span>
                  ))}
                </div>
              </>
            ) : null}
            <span className="verified-line">
              <b>✓</b> This device is approved
            </span>
            {selected && (
              <div className="session-menu-actions">
                {selectedArchived ? (
                  <button
                    type="button"
                    className="session-menu-primary"
                    disabled={
                      selectedLifecycleBusy ||
                      !gatewayAvailable ||
                      !gatewayState?.capabilities.canArchiveSession
                    }
                    onClick={() => void restoreSession(selected.id)}
                  >
                    <span aria-hidden="true">↺</span>
                    <span>
                      <strong>Restore session</strong>
                      <small>Return it to Recent</small>
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="session-menu-primary"
                    disabled={
                      selectedLifecycleBusy ||
                      !gatewayAvailable ||
                      !gatewayState?.capabilities.canArchiveSession
                    }
                    onClick={() => void archiveSession(selected.id)}
                  >
                    <span aria-hidden="true">▣</span>
                    <span>
                      <strong>
                        {isStreaming ? "Archive & stop agent" : "Archive session"}
                      </strong>
                      <small>Keep it available to restore</small>
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="session-menu-danger"
                  disabled={
                    selectedLifecycleBusy ||
                    !gatewayAvailable ||
                    !gatewayState?.capabilities.canDeleteSession
                  }
                  onClick={() => {
                    setDetailsOpen(false);
                    setDeleteTarget(selected);
                  }}
                >
                  <span aria-hidden="true">×</span>
                  <span>
                    <strong>Delete session</strong>
                    <small>Remove it from Codever</small>
                  </span>
                </button>
              </div>
            )}
          </div>
        )}

        {selectedArchived && selected && (
          <section className="archived-session-banner" role="status">
            <span className="archive-banner-icon" aria-hidden="true">▣</span>
            <span>
              <strong>This session is archived</strong>
              <small>Its history remains available. Restore it to continue working.</small>
            </span>
            <button
              type="button"
              disabled={
                selectedLifecycleBusy ||
                !gatewayAvailable ||
                !gatewayState?.capabilities.canArchiveSession
              }
              onClick={() => void restoreSession(selected.id)}
            >
              {selectedLifecycleBusy ? "Restoring…" : "Restore"}
            </button>
          </section>
        )}

        <div
          className="chat-feed"
          ref={feedRef}
          onScroll={handleFeedScroll}
        >
          <UiNoticeList
            notices={historyNotices}
            className="history-notices"
            onDismiss={dismissUiNotice}
          />
          <div
            className={`history-loader ${historyLoading ? "is-loading" : ""} ${historyError ? "has-error" : ""}`}
            aria-live="polite"
          >
            {historyLoading ? (
              <span>Loading earlier messages…</span>
            ) : historyError ? (
              <span className="history-inline-error">
                <span>{historyError}</span>
                <button
                  type="button"
                  onClick={() =>
                    historyRetryMode === "restore" &&
                    historySessionIdRef.current
                      ? void restoreSessionHistory(historySessionIdRef.current)
                      : void loadOlderHistory()
                  }
                >
                  Retry
                </button>
              </span>
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
          {messages.map((message, messageIndex) => {
            const agentWork = isAgentWorkMessage(message);
            const previousIsAgentWork = isAgentWorkMessage(
              messages[messageIndex - 1],
            );
            const nextIsAgentWork = isAgentWorkMessage(
              messages[messageIndex + 1],
            );
            const agentTurnClass = agentWork
              ? `${previousIsAgentWork ? "agent-turn-continuation" : "agent-turn-start"} ${nextIsAgentWork ? "" : "agent-turn-end"}`
              : "";
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
                    <span className="agent-label">TASK NEEDS ATTENTION</span>
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
                    <AttachmentList
                      attachments={message.attachments}
                      connection={codeverClientRef.current}
                    />
                    <time
                      title={
                        message.revision !== undefined
                          ? `Gateway revision ${message.revision}`
                          : undefined
                      }
                    >
                      {message.time}{" "}
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
                    {deliveryState === "failed" && (
                      <button
                        type="button"
                        className="failed-message-retry"
                        onClick={() => restoreFailedMessage(message)}
                      >
                        Edit and retry
                      </button>
                    )}
                  </div>
                </div>
              );
            }
            if (message.kind === "tool") {
              if (!message.toolGroup) return null;
              return (
                <div
                  className={`message-row tool-group-row ${agentTurnClass} ${
                    message.historical ? "" : "message-enter"
                  }`}
                  key={message.id}
                >
                  <ToolGroupCard group={message.toolGroup} time={message.time} />
                </div>
              );
            }
            if (message.kind === "permission") {
              const decisionState =
                decisionStates[message.id] ?? "pending";
              const permissionDetails =
                typeof message.raw?.details === "string"
                  ? message.raw.details
                  : undefined;
              const permissionLabels = permissionActionLabels(message.raw);
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
                        <small>Your approval is required</small>
                      </div>
                    </div>
                    <p>
                      Your choice is protected and sent only to your connected
                      computer.
                    </p>
                    {permissionDetails && (
                      <pre className="permission-details">{permissionDetails}</pre>
                    )}
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
                          {permissionLabels.approve}
                        </button>
                        <button
                          className="deny-button"
                          onClick={() => void decidePermission(message, "deny")}
                        >
                          {permissionLabels.deny}
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
                className={`message-row agent-row ${agentTurnClass} ${
                  message.historical ? "" : "message-enter"
                }`}
                key={message.id}
              >
                <div className="agent-mark">C</div>
                <div className="bubble agent-bubble">
                  <span className="agent-label">CODEX</span>
                  {message.format === "markdown" || !message.format ? (
                    <MarkdownContent content={message.text ?? ""} />
                  ) : (
                    <p className="message-copy">
                      {message.text}
                    </p>
                  )}
                  <AttachmentList
                    attachments={message.attachments}
                    connection={codeverClientRef.current}
                  />
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
          {feedAwayFromLatest && (
            <button
              type="button"
              className="jump-to-latest"
              onClick={scrollFeedToLatest}
            >
              ↓ Latest messages
            </button>
          )}
          <div className="context-strip">
            <div className="context-item">
              <span className="context-icon">▱</span>
              <span>
                <small>Project · Computer</small>
                <b title={activeWorkspace?.cwd}>
                  {activeWorkspace?.projectName || "Syncing conversations…"}
                  {trustedGateway ? ` · ${trustedGateway.gatewayName}` : ""}
                </b>
              </span>
            </div>
            <div className="context-item branch-item">
              <span className="branch-mark">⑂</span>
              <code>{activeWorkspace?.provider || "Agent"}</code>
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

          {nativeCommandReview && (
            <section className="revision-conflict-card" role="alert">
              <div>
                <strong>{nativeCommandReviewTitle(nativeCommandReview.operation)}</strong>
                <p>
                  {nativeCommandReviewDescription(nativeCommandReview.operation)}
                </p>
              </div>
              <div className="revision-conflict-actions">
                <button
                  type="button"
                  disabled={nativeCommandReview.busy}
                  onClick={() => void discardNativeCommandReview()}
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={nativeCommandReview.busy}
                  onClick={() => void retryNativeCommandReview()}
                >
                  {nativeCommandReview.busy ? "Retrying…" : "Retry previous action"}
                </button>
              </div>
            </section>
          )}

          <UiNoticeList
            notices={composerNotices}
            className="composer-notices"
            onDismiss={dismissUiNotice}
          />

          {pendingFiles.length > 0 && (
            <div className="pending-attachments" aria-label="Pending attachments">
              {pendingFiles.map((file, index) => (
                <span className="pending-attachment" key={`${file.name}:${file.size}:${index}`}>
                  <span aria-hidden="true">
                    {file.type.startsWith("image/") ? "▧" : "▤"}
                  </span>
                  <span>
                    <b>{file.name}</b>
                    <small>{formatFileSize(file.size)}</small>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    disabled={attachmentBusy}
                    onClick={() =>
                      setPendingFiles((current) =>
                        current.filter((_, candidateIndex) => candidateIndex !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <form
            className={`composer ${composerOptionsOpen ? "composer-options-open" : ""}`}
            onSubmit={(event) => void sendMessage(event)}
          >
            <textarea
              ref={composerTextareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={
                selectedArchived
                  ? "Restore this session to continue"
                  : gatewayAvailable
                  ? `Message ${activeProvider}…`
                  : trustedGateway
                    ? "Connect your computer to send messages"
                    : "Connect a computer to start"
              }
              aria-label={`Message ${activeProvider}`}
              rows={1}
              disabled={!composerState.canType}
            />
            <div className="composer-actions">
              <input
                ref={attachmentInputRef}
                className="attachment-input"
                type="file"
                multiple
                onChange={selectAttachments}
                tabIndex={-1}
              />
              <button
                type="button"
                className="attachment-button"
                aria-label="Attach a file"
                disabled={!sessionReady || attachmentBusy}
                onClick={() => attachmentInputRef.current?.click()}
              >
                {attachmentBusy ? "…" : "+"}
              </button>
              <button
                type="button"
                className="composer-options-button"
                aria-label="Agent options"
                aria-expanded={composerOptionsOpen}
                aria-controls="composer-agent-options"
                onClick={() => setComposerOptionsOpen((open) => !open)}
              >
                <span aria-hidden="true">•••</span>
              </button>
              <div id="composer-agent-options" className="agent-controls">
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
                      <option value="">Computer default</option>
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
              <div className="composer-submit-actions">
                {isStreaming && (
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
                )}
                <button
                  key="send-message"
                  type="submit"
                  className="send-button mount-feedback"
                  disabled={!composerState.canSend}
                  aria-label={
                    composerState.mode === "queue"
                      ? "Queue message"
                      : "Send message"
                  }
                  aria-describedby="composer-status"
                  title={composerState.reason}
                >
                  ↑
                </button>
              </div>
            </div>
          </form>
          <p
            id="composer-status"
            className={`composer-hint composer-hint-${composerState.mode}`}
            role="status"
            aria-live="polite"
          >
            {composerState.reason}
          </p>
        </div>
      </section>

      {pwaUpdateState.phase === "updating" && (
        <div className="pwa-update-overlay" role="alert" aria-live="assertive">
          <span className="pwa-update-spinner" aria-hidden="true" />
          <strong>Updating Codever…</strong>
          <small>
            Loading build {pwaUpdateState.latestVersion}. This page will reopen
            automatically.
          </small>
        </div>
      )}

      {pwaUpdateState.phase === "waiting" && (
        <div className="pwa-update-toast" role="status" aria-live="polite">
          <span aria-hidden="true">↻</span>
          <span>
            <strong>Update ready</strong>
            <small>
              Finishing the queued session command before Codever reloads.
            </small>
          </span>
        </div>
      )}

      {pwaUpdateState.phase === "updated" && (
        <div className="pwa-update-toast" role="status" aria-live="polite">
          <span aria-hidden="true">✓</span>
          <span>
            <strong>Codever updated</strong>
            <small>Now running build {pwaUpdateState.currentVersion}</small>
          </span>
          <button
            type="button"
            aria-label="Dismiss update notice"
            onClick={() => pwaUpdateRef.current?.dismissUpdatedNotice()}
          >
            ×
          </button>
        </div>
      )}

      {(pairingError ?? connectionError) && !settingsOpen && (
        <button
          className="connection-toast"
          role="alert"
          onClick={() => setSettingsOpen(true)}
        >
          <span>!</span>
          <span>
            <strong>Connection needs attention</strong>
            <small>{pairingError ?? connectionError}</small>
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
          sessions={visibleGatewaySessions}
          models={gatewayState.capabilities.models}
          extensions={gatewayState.capabilities.sessionExtensions}
          onClose={() => {
            if (!newSessionBusy) setNewSessionOpen(false);
          }}
          onCreate={(input) => void createSession(input)}
        />
      )}

      <SessionDeleteDialog
        session={deleteTarget}
        busy={deleteDialogBusy}
        onClose={() => {
          if (!deleteDialogBusy) setDeleteTarget(null);
        }}
        onConfirm={() => void deleteSession()}
      />

      <MatrixSettings
        open={settingsOpen}
        config={matrixConfig}
        status={displayedConnectionStatus}
        progressDetail={connectionPresentation.detail}
        repairRequired={matrixSessionRepairRequired}
        error={pairingError ?? connectionError}
        pairingPreview={pairingPreview}
        trustedGateway={trustedGateway}
        pairingBusy={pairingBusy}
        deviceInvitation={deviceInvitation}
        invitationBusy={invitationBusy}
        invitationError={invitationError}
        invitationReauthRequired={invitationReauthRequired}
        updateState={pwaUpdateState}
        nativeRuntime={nativeRuntime}
        onChange={setMatrixConfig}
        onPairingLink={(link) => void openPairingLink(link)}
        onClearPairing={() => {
          pairingAbortRef.current?.abort();
          setPairingPreview(null);
          setPairingError(null);
          setConnectionError(null);
        }}
        onConfirmPairing={() => void confirmPairing()}
        onClose={() => setSettingsOpen(false)}
        onConnect={() => void connectCodeverClient()}
        onDisconnect={() => disconnectClient()}
        onForget={() => setForgetDialogOpen(true)}
        onPasswordLogin={(userId, password) =>
          void signInForPairing(userId, password)
        }
        onCreateInvitation={(password) =>
          void createDeviceInvitation(password)
        }
        onClearInvitation={() => {
          deviceInvitationLifecycleRef.current.clear();
          matrixLoginTokenLifecycleRef.current.clear();
          const pendingGatewayInvitation = pendingGatewayInvitationRef.current;
          if (pendingGatewayInvitation) {
            void codeverClientRef.current?.releaseCommand(
              pendingGatewayInvitation.commandId,
            );
          }
          pendingGatewayInvitationRef.current = null;
          if (invitationExpiryTimeoutRef.current !== null) {
            window.clearTimeout(invitationExpiryTimeoutRef.current);
            invitationExpiryTimeoutRef.current = null;
          }
          setDeviceInvitation(null);
          setInvitationReauthRequired(false);
          setInvitationError(null);
        }}
        onCheckForUpdates={() => void pwaUpdateRef.current?.checkNow()}
      />

      <GatewayForgetDialog
        open={forgetDialogOpen}
        gatewayName={trustedGateway?.gatewayName ?? null}
        busy={false}
        onClose={() => setForgetDialogOpen(false)}
        onConfirm={() => {
          setForgetDialogOpen(false);
          forgetMatrixConfig();
        }}
      />
    </main>
  );
}

function commandNoticeFor(payload: CommandPayload): {
  key: string;
  scope: "session" | "composer" | "pairing";
} {
  if (payload.operation === "device.invite") {
    return { key: "pairing:device-invite", scope: "pairing" };
  }
  if (payload.operation === "prompt") {
    return { key: "composer:send", scope: "composer" };
  }
  if (payload.operation.startsWith("session.")) {
    return {
      key: `session:${payload.operation.slice("session.".length)}`,
      scope: "session",
    };
  }
  return { key: `composer:${payload.operation}`, scope: "composer" };
}

function agentLifecycleFailureText(
  raw: Record<string, unknown>,
): string | null {
  if (raw.kind === "status" && raw.state === "failed") {
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
    operationId: incoming.operationId,
    requestId: incoming.requestId,
    replacesEventId: incoming.replacesEventId,
    commandId: incoming.commandId,
    revision: incoming.revision,
    originDeviceId: incoming.originDeviceId,
    originDeviceName: incoming.originDeviceName,
    format: incoming.format,
    toolGroup: incoming.toolGroup,
    attachments: incoming.attachments,
    sessionId,
    historical: incoming.historical,
    raw: incoming.raw,
  };
}

function incomingMessageFromClient(
  message: CodeverMessage,
): IncomingCodeverMessage {
  return {
    eventId: message.eventId,
    sender: message.sender,
    timestamp: message.timestamp,
    encrypted: message.encrypted,
    kind: message.kind,
    text: message.text ?? "",
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
    raw: message.semantic ?? {},
  };
}

function permissionActionLabels(
  raw: Record<string, unknown> | undefined,
): { approve: string; deny: string } {
  const options = Array.isArray(raw?.options) ? raw.options : [];
  const labelFor = (value: "allow" | "deny"): string | undefined => {
    const option = options.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).value === value,
    ) as Record<string, unknown> | undefined;
    return typeof option?.label === "string" && option.label.trim()
      ? option.label
      : undefined;
  };
  return {
    approve: labelFor("allow") ?? "Allow once",
    deny: labelFor("deny") ?? "Deny",
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
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
    case "session.archive":
      return "The archive request";
    case "session.restore":
      return "The restore request";
    case "session.delete":
      return "The delete request";
    case "device.invite":
      return "The device invitation request";
  }
}

function nativeCommandReviewTitle(
  operation: CommandPayload["operation"] | undefined,
): string {
  switch (operation) {
    case "session.delete":
      return "Session deletion needs review";
    case "session.archive":
      return "Session archive needs review";
    case "session.restore":
      return "Session restore needs review";
    case "session.create":
      return "Session creation needs review";
    case "prompt":
      return "A previous prompt needs review";
    case "decision":
      return "A permission decision needs review";
    case "session.settings":
      return "A settings change needs review";
    case "cancel":
      return "A cancel action needs review";
    case "device.invite":
      return "A device invitation needs review";
    default:
      return "A previous action needs review";
  }
}

function nativeCommandReviewDescription(
  operation: CommandPayload["operation"] | undefined,
): string {
  const action = (() => {
    switch (operation) {
      case "session.delete":
        return "session deletion";
      case "session.archive":
        return "session archive";
      case "session.restore":
        return "session restore";
      case "session.create":
        return "session creation";
      case "prompt":
        return "prompt";
      case "decision":
        return "permission decision";
      case "session.settings":
        return "settings change";
      case "cancel":
        return "cancel action";
      case "device.invite":
        return "device invitation";
      default:
        return "action";
    }
  })();
  return `Another device changed the Gateway before this ${action} was accepted. Review the latest state, then retry it or discard it before starting new work.`;
}

function lifecyclePastTense(
  action: "archive" | "restore" | "delete",
): string {
  switch (action) {
    case "archive":
      return "archived";
    case "restore":
      return "restored";
    case "delete":
      return "deleted";
  }
}

function sessionLifecyclePayload(
  action: "archive" | "restore" | "delete",
  sessionId: string,
): Extract<
  CommandPayload,
  {
    operation:
      | "session.archive"
      | "session.restore"
      | "session.delete";
  }
> {
  switch (action) {
    case "archive":
      return { operation: "session.archive", sessionId };
    case "restore":
      return { operation: "session.restore", sessionId };
    case "delete":
      return { operation: "session.delete", sessionId };
  }
}

function formatUiError(error: unknown): string {
  return formatUserFacingError(error);
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
    throw new Error("Your computer returned an invalid device invitation.");
  }
  const result = input as Record<string, unknown>;
  if (
    typeof result.pairingLink !== "string" ||
    !result.pairingLink ||
    typeof result.expiresAt !== "number" ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.expiresAt <= Date.now()
  ) {
    throw new Error("Your computer returned an invalid device invitation.");
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
