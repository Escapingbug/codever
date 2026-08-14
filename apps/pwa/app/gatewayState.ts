import type {
  SessionExtensionDescriptor,
  SessionExtensionSummary,
} from "@codever/protocol";

export type GatewayCapabilityOption = {
  id: string;
  name: string;
};

export type GatewayReasoningLevel = {
  effort: string;
  description?: string;
};

export type GatewayModelCapability = GatewayCapabilityOption & {
  defaultReasoningLevel?: string;
  supportedReasoningLevels: GatewayReasoningLevel[];
};

export type GatewaySessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  status: "idle" | "running" | "stopping" | "failed" | "archived";
  activityPhase?:
    | "starting"
    | "working"
    | "stopping"
    | "idle"
    | "failed";
  projectId: string;
  projectName: string;
  cwd: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  extensions: SessionExtensionSummary[];
};

export type GatewayWorkspaceState = {
  projectId: string;
  projectName: string;
  cwd: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode: string;
};

export type GatewayCapabilities = {
  models: GatewayModelCapability[];
  permissionModes: GatewayCapabilityOption[];
  canCreateSession: boolean;
  canSelectSession: boolean;
  canArchiveSession?: boolean;
  canDeleteSession?: boolean;
  sessionExtensions: SessionExtensionDescriptor[];
};

export type GatewayStateSnapshot = {
  stateVersion: number;
  revision: number;
  revisionEpoch: string;
  revisionEpochGeneration: number;
  activeDeviceCount: number;
  currentSessionId: string | null;
  sessions: GatewaySessionSummary[];
  workspace: GatewayWorkspaceState;
  capabilities: GatewayCapabilities;
};

export type GatewayStateCacheBinding = {
  gatewayId: string;
  conversationId: string;
  identityKeyId: string;
  certificateId: string;
};

export type GatewayStateCacheEpoch = {
  revisionEpoch: string;
  revisionEpochGeneration: number;
  stateVersion: number;
  revision: number;
};

export function classifyGatewayStateEpoch(
  currentEpoch: string | undefined,
  currentGeneration: number | undefined,
  retiredEpochs: readonly string[],
  incomingEpoch: string,
  incomingGeneration: number,
): "current" | "new" | "retired" | "stale" | "conflict" {
  if (retiredEpochs.includes(incomingEpoch)) return "retired";
  if (currentEpoch === undefined || currentGeneration === undefined) return "new";
  if (incomingGeneration < currentGeneration) return "stale";
  if (incomingGeneration > currentGeneration) return "new";
  return incomingEpoch === currentEpoch ? "current" : "conflict";
}

/**
 * Gateway metadata versions and semantic revisions advance independently.
 * Per-session Room State can change without replacing Gateway metadata, so an
 * equal Gateway state version is not evidence of a conflicting room view.
 */
export function classifyGatewayStateProgress(
  current: Pick<GatewayStateCacheEpoch, "stateVersion" | "revision">,
  incoming: Pick<GatewayStateCacheEpoch, "stateVersion" | "revision">,
): "current" | "advance" | "stale" {
  if (
    incoming.stateVersion < current.stateVersion ||
    incoming.revision < current.revision
  ) {
    return "stale";
  }
  return incoming.stateVersion === current.stateVersion &&
    incoming.revision === current.revision
      ? "current"
      : "advance";
}

export function isIgnorableGatewayStateReplay(
  epochStatus: ReturnType<typeof classifyGatewayStateEpoch>,
  progress?: ReturnType<typeof classifyGatewayStateProgress>,
): boolean {
  return (
    epochStatus === "retired" ||
    epochStatus === "stale" ||
    (epochStatus === "current" && progress === "stale")
  );
}

export function parseGatewayStateExtension(
  value: unknown,
): GatewayStateSnapshot | null {
  const extension = asRecord(value);
  if (extension?.kind !== "gateway_state") return null;
  if (
    extension.version !== 1 ||
    !isPositiveInteger(extension.state_version) ||
    !isNonnegativeInteger(extension.revision) ||
    typeof extension.revision_epoch !== "string" ||
    extension.revision_epoch.length === 0 ||
    !isPositiveInteger(extension.revision_epoch_generation) ||
    !isPositiveInteger(extension.active_device_count) ||
    !(
      extension.current_session_id === null ||
      typeof extension.current_session_id === "string"
    ) ||
    !Array.isArray(extension.sessions)
  ) {
    throw new Error("The authenticated Gateway state snapshot is malformed.");
  }

  const parsedSessions = extension.sessions.map((value) => {
    const session = asRecord(value);
    if (
      !session ||
      typeof session.id !== "string" ||
      !session.id ||
      typeof session.title !== "string" ||
      !session.title ||
      !isNonnegativeInteger(session.updated_at) ||
      !(
        session.status === "idle" ||
        session.status === "running" ||
        session.status === "stopping" ||
        session.status === "failed"
      ) ||
      !(
        session.activity_phase === undefined ||
        session.activity_phase === "starting" ||
        session.activity_phase === "working" ||
        session.activity_phase === "stopping" ||
        session.activity_phase === "idle" ||
        session.activity_phase === "failed"
      ) ||
      !(
        session.archived === undefined ||
        typeof session.archived === "boolean"
      ) ||
      typeof session.provider !== "string" ||
      !session.provider ||
      !(
        session.model === undefined ||
        (typeof session.model === "string" && session.model.length > 0)
      ) ||
      !(
        session.reasoning_effort === undefined ||
        (typeof session.reasoning_effort === "string" &&
          session.reasoning_effort.length > 0)
      ) ||
      typeof session.cwd !== "string" ||
      session.cwd.length === 0 ||
      !Array.isArray(session.extensions) ||
      typeof session.project_id !== "string" ||
      session.project_id.length === 0 ||
      typeof session.project_name !== "string" ||
      session.project_name.length === 0
    ) {
      throw new Error("The authenticated Gateway session summary is malformed.");
    }
    const status: GatewaySessionSummary["status"] = session.archived === true
      ? "archived"
      : session.status === "running" ||
          session.status === "stopping" ||
          session.status === "failed"
        ? session.status
        : "idle";
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updated_at,
      status,
      ...(typeof session.activity_phase === "string"
        ? {
            activityPhase:
              session.activity_phase as GatewaySessionSummary["activityPhase"],
          }
        : {}),
      provider: session.provider,
      ...(typeof session.model === "string" ? { model: session.model } : {}),
      ...(typeof session.reasoning_effort === "string"
        ? { reasoningEffort: session.reasoning_effort }
        : {}),
      projectId: session.project_id,
      projectName: session.project_name,
      cwd: session.cwd,
      extensions: parseSessionExtensionSummaries(session.extensions),
    };
  });

  const workspace = asRecord(extension.workspace);
  if (
    !workspace ||
    typeof workspace.cwd !== "string" ||
    workspace.cwd.length === 0 ||
    typeof workspace.provider !== "string" ||
    !workspace.provider ||
    typeof workspace.permission_mode !== "string" ||
    !workspace.permission_mode ||
    typeof workspace.project_id !== "string" ||
    workspace.project_id.length === 0 ||
    typeof workspace.project_name !== "string" ||
    workspace.project_name.length === 0 ||
    !(
      workspace.reasoning_effort === undefined ||
      (typeof workspace.reasoning_effort === "string" &&
        workspace.reasoning_effort.length > 0)
    ) ||
    !(
      workspace.model === undefined ||
      (typeof workspace.model === "string" && workspace.model.length > 0)
    )
  ) {
    throw new Error("The authenticated Gateway workspace state is malformed.");
  }
  const workspaceCwd = workspace.cwd as string;
  const sessions: GatewaySessionSummary[] = parsedSessions.map((session) => {
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      status: session.status,
      ...(session.activityPhase ? { activityPhase: session.activityPhase } : {}),
      projectId: session.projectId,
      projectName: session.projectName,
      cwd: session.cwd,
      provider: session.provider,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort
        ? { reasoningEffort: session.reasoningEffort }
        : {}),
      extensions: session.extensions,
    };
  });

  const capabilities = asRecord(extension.capabilities);
  if (
    !capabilities ||
    !Array.isArray(capabilities.models) ||
    !Array.isArray(capabilities.permission_modes) ||
    typeof capabilities.can_create_session !== "boolean" ||
    typeof capabilities.can_select_session !== "boolean"
  ) {
    throw new Error("The authenticated Gateway capabilities are malformed.");
  }

  const parseOptions = (
    values: unknown[],
    label: string,
  ): GatewayCapabilityOption[] =>
    values.map((value) => {
      const option = asRecord(value);
      if (
        !option ||
        typeof option.id !== "string" ||
        !option.id ||
        typeof option.name !== "string" ||
        !option.name
      ) {
        throw new Error(
          `The authenticated Gateway ${label} capability is malformed.`,
        );
      }
      return { id: option.id, name: option.name };
    });
  const parseModels = (values: unknown[]): GatewayModelCapability[] =>
    values.map((value) => {
      const option = asRecord(value);
      if (
        !option ||
        typeof option.id !== "string" ||
        !option.id ||
        typeof option.name !== "string" ||
        !option.name ||
        !(
          option.default_reasoning_level === undefined ||
          (typeof option.default_reasoning_level === "string" &&
            option.default_reasoning_level.length > 0)
        ) ||
        !(
          option.supported_reasoning_levels === undefined ||
          Array.isArray(option.supported_reasoning_levels)
        )
      ) {
        throw new Error(
          "The authenticated Gateway model capability is malformed.",
        );
      }
      const levels = (option.supported_reasoning_levels ?? []).map((level) => {
        const record = asRecord(level);
        if (
          !record ||
          typeof record.effort !== "string" ||
          !record.effort ||
          !(
            record.description === undefined ||
            typeof record.description === "string"
          )
        ) {
          throw new Error(
            "The authenticated Gateway reasoning capability is malformed.",
          );
        }
        return {
          effort: record.effort,
          ...(typeof record.description === "string"
            ? { description: record.description }
            : {}),
        };
      });
      return {
        id: option.id,
        name: option.name,
        ...(typeof option.default_reasoning_level === "string"
          ? { defaultReasoningLevel: option.default_reasoning_level }
          : {}),
        supportedReasoningLevels: levels,
      };
    });
  const sessionExtensions = parseSessionExtensionDescriptors(
    capabilities.session_extensions,
  );

  const currentSessionId = extension.current_session_id;
  if (
    typeof currentSessionId === "string" &&
    !sessions.some((session) => session.id === currentSessionId)
  ) {
    throw new Error(
      "The authenticated Gateway current session is missing from its session list.",
    );
  }

  return {
    stateVersion: extension.state_version,
    revision: extension.revision,
    revisionEpoch: extension.revision_epoch,
    revisionEpochGeneration: extension.revision_epoch_generation,
    activeDeviceCount: extension.active_device_count,
    currentSessionId,
    sessions,
    workspace: {
      projectId: workspace.project_id,
      projectName: workspace.project_name,
      cwd: workspaceCwd,
      provider: workspace.provider,
      ...(typeof workspace.model === "string"
        ? { model: workspace.model }
        : {}),
      ...(typeof workspace.reasoning_effort === "string"
        ? { reasoningEffort: workspace.reasoning_effort }
        : {}),
      permissionMode: workspace.permission_mode,
    },
    capabilities: {
      models: parseModels(capabilities.models),
      permissionModes: parseOptions(
        capabilities.permission_modes,
        "permission mode",
      ),
      canCreateSession: capabilities.can_create_session,
      canSelectSession: capabilities.can_select_session,
      ...(typeof capabilities.can_archive_session === "boolean"
        ? { canArchiveSession: capabilities.can_archive_session }
        : {}),
      ...(typeof capabilities.can_delete_session === "boolean"
        ? { canDeleteSession: capabilities.can_delete_session }
        : {}),
      sessionExtensions,
    },
  };
}

export function gatewayProjectKey(
  gatewayId: string,
  projectId: string,
): string {
  return `${gatewayId}\u0000${projectId}`;
}

export function createGatewayStateCacheRecord(
  binding: GatewayStateCacheBinding,
  state: GatewayStateSnapshot,
): Record<string, unknown> {
  return {
    kind: "gateway_state_cache",
    version: 1,
    gateway_id: binding.gatewayId,
    conversation_id: binding.conversationId,
    identity_key_id: binding.identityKeyId,
    certificate_id: binding.certificateId,
    snapshot: gatewayStateExtension(state),
  };
}

export function parseGatewayStateCacheRecord(
  value: unknown,
  binding: GatewayStateCacheBinding,
  epoch: GatewayStateCacheEpoch,
): GatewayStateSnapshot | null {
  const record = asRecord(value);
  if (
    record?.kind !== "gateway_state_cache" ||
    record.version !== 1 ||
    record.gateway_id !== binding.gatewayId ||
    record.conversation_id !== binding.conversationId ||
    record.identity_key_id !== binding.identityKeyId ||
    record.certificate_id !== binding.certificateId
  ) {
    return null;
  }
  let state: GatewayStateSnapshot | null;
  try {
    state = parseGatewayStateExtension(record.snapshot);
  } catch {
    return null;
  }
  if (
    !state ||
    state.revisionEpoch !== epoch.revisionEpoch ||
    state.revisionEpochGeneration !== epoch.revisionEpochGeneration ||
    state.stateVersion !== epoch.stateVersion ||
    state.revision !== epoch.revision
  ) {
    return null;
  }
  return state;
}

function gatewayStateExtension(
  state: GatewayStateSnapshot,
): Record<string, unknown> {
  return {
    kind: "gateway_state",
    version: 1,
    state_version: state.stateVersion,
    revision: state.revision,
    revision_epoch: state.revisionEpoch,
    revision_epoch_generation: state.revisionEpochGeneration,
    active_device_count: state.activeDeviceCount,
    current_session_id: state.currentSessionId,
    sessions: state.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updated_at: session.updatedAt,
      status: session.status === "archived" ? "idle" : session.status,
      ...(session.activityPhase ? { activity_phase: session.activityPhase } : {}),
      ...(session.status === "archived" ? { archived: true } : {}),
      project_id: session.projectId,
      project_name: session.projectName,
      cwd: session.cwd,
      provider: session.provider,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort
        ? { reasoning_effort: session.reasoningEffort }
        : {}),
      extensions: session.extensions.map((extension) => ({
        id: extension.id,
        name: extension.name,
        version: extension.version,
      })),
    })),
    workspace: {
      project_id: state.workspace.projectId,
      project_name: state.workspace.projectName,
      cwd: state.workspace.cwd,
      provider: state.workspace.provider,
      ...(state.workspace.model ? { model: state.workspace.model } : {}),
      ...(state.workspace.reasoningEffort
        ? { reasoning_effort: state.workspace.reasoningEffort }
        : {}),
      permission_mode: state.workspace.permissionMode,
    },
    capabilities: {
      models: state.capabilities.models.map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.defaultReasoningLevel
          ? { default_reasoning_level: model.defaultReasoningLevel }
          : {}),
        supported_reasoning_levels: model.supportedReasoningLevels.map(
          (level) => ({
            effort: level.effort,
            ...(level.description ? { description: level.description } : {}),
          }),
        ),
      })),
      permission_modes: state.capabilities.permissionModes.map((mode) => ({
        id: mode.id,
        name: mode.name,
      })),
      can_create_session: state.capabilities.canCreateSession,
      can_select_session: state.capabilities.canSelectSession,
      ...(state.capabilities.canArchiveSession === undefined
        ? {}
        : { can_archive_session: state.capabilities.canArchiveSession }),
      ...(state.capabilities.canDeleteSession === undefined
        ? {}
        : { can_delete_session: state.capabilities.canDeleteSession }),
      session_extensions: state.capabilities.sessionExtensions.map(
        (extension) => ({
          id: extension.id,
          name: extension.name,
          description: extension.description,
          version: extension.version,
          settings: extension.settings.map((setting) => ({
            id: setting.id,
            type: setting.type,
            label: setting.label,
            ...(setting.description
              ? { description: setting.description }
              : {}),
            ...(setting.type === "text" && setting.required
              ? { required: true }
              : {}),
            ...(setting.type === "text" && setting.placeholder
              ? { placeholder: setting.placeholder }
              : {}),
            ...(setting.defaultValue === undefined
              ? {}
              : { default_value: setting.defaultValue }),
          })),
        }),
      ),
    },
  };
}

function parseSessionExtensionSummaries(value: unknown): SessionExtensionSummary[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("The authenticated Gateway session extensions are malformed.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const extension = asRecord(entry);
    if (
      !extension ||
      typeof extension.id !== "string" ||
      !extension.id ||
      typeof extension.name !== "string" ||
      !extension.name ||
      typeof extension.version !== "string" ||
      !extension.version ||
      seen.has(extension.id)
    ) {
      throw new Error("The authenticated Gateway session extension is malformed.");
    }
    seen.add(extension.id);
    return {
      id: extension.id,
      name: extension.name,
      version: extension.version,
    };
  });
}

function parseSessionExtensionDescriptors(value: unknown): SessionExtensionDescriptor[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("The authenticated Gateway extension capabilities are malformed.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const extension = asRecord(entry);
    if (
      !extension ||
      typeof extension.id !== "string" ||
      !extension.id ||
      typeof extension.name !== "string" ||
      !extension.name ||
      typeof extension.description !== "string" ||
      typeof extension.version !== "string" ||
      !extension.version ||
      !Array.isArray(extension.settings) ||
      seen.has(extension.id)
    ) {
      throw new Error("The authenticated Gateway extension capability is malformed.");
    }
    seen.add(extension.id);
    const settingIds = new Set<string>();
    const settings = extension.settings.map((entry) => {
      const setting = asRecord(entry);
      if (
        !setting ||
        typeof setting.id !== "string" ||
        !setting.id ||
        (setting.type !== "text" && setting.type !== "boolean") ||
        typeof setting.label !== "string" ||
        !setting.label ||
        !(setting.description === undefined || typeof setting.description === "string") ||
        settingIds.has(setting.id)
      ) {
        throw new Error("The authenticated Gateway extension setting is malformed.");
      }
      settingIds.add(setting.id);
      if (setting.type === "boolean") {
        if (!(setting.default_value === undefined || typeof setting.default_value === "boolean")) {
          throw new Error("The authenticated Gateway boolean extension setting is malformed.");
        }
        return {
          id: setting.id,
          type: "boolean" as const,
          label: setting.label,
          ...(typeof setting.description === "string"
            ? { description: setting.description }
            : {}),
          ...(typeof setting.default_value === "boolean"
            ? { defaultValue: setting.default_value }
            : {}),
        };
      }
      if (
        !(setting.required === undefined || typeof setting.required === "boolean") ||
        !(setting.placeholder === undefined || typeof setting.placeholder === "string") ||
        !(setting.default_value === undefined || typeof setting.default_value === "string")
      ) {
        throw new Error("The authenticated Gateway text extension setting is malformed.");
      }
      return {
        id: setting.id,
        type: "text" as const,
        label: setting.label,
        ...(typeof setting.description === "string"
          ? { description: setting.description }
          : {}),
        ...(typeof setting.required === "boolean"
          ? { required: setting.required }
          : {}),
        ...(typeof setting.placeholder === "string"
          ? { placeholder: setting.placeholder }
          : {}),
        ...(typeof setting.default_value === "string"
          ? { defaultValue: setting.default_value }
          : {}),
      };
    });
    return {
      id: extension.id,
      name: extension.name,
      description: extension.description,
      version: extension.version,
      settings,
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}
