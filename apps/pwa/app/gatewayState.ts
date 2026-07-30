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
  status: "idle" | "running" | "stopping" | "failed";
  projectId: string;
  projectName: string;
  cwd: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
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

export function canMigrateLegacyGatewayState(
  currentEpoch: string,
  currentStateVersion: number,
  incomingEpoch: string,
  incomingStateVersion: number,
): boolean {
  return (
    incomingEpoch === currentEpoch ||
    incomingStateVersion > currentStateVersion
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
        session.status === undefined ||
        session.status === "idle" ||
        session.status === "running" ||
        session.status === "stopping" ||
        session.status === "failed"
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
      !(session.cwd === undefined || typeof session.cwd === "string") ||
      !(
        session.project_id === undefined ||
        (typeof session.project_id === "string" && session.project_id.length > 0)
      ) ||
      !(
        session.project_name === undefined ||
        (typeof session.project_name === "string" &&
          session.project_name.length > 0)
      )
    ) {
      throw new Error("The authenticated Gateway session summary is malformed.");
    }
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updated_at,
      status:
        session.status === "running" ||
        session.status === "stopping" ||
        session.status === "failed"
          ? session.status
          : "idle",
      provider: session.provider,
      ...(typeof session.model === "string" ? { model: session.model } : {}),
      ...(typeof session.reasoning_effort === "string"
        ? { reasoningEffort: session.reasoning_effort }
        : {}),
      rawProjectId:
        typeof session.project_id === "string" ? session.project_id : undefined,
      rawProjectName:
        typeof session.project_name === "string"
          ? session.project_name
          : undefined,
      rawCwd: typeof session.cwd === "string" ? session.cwd : undefined,
    };
  });

  const workspace = asRecord(extension.workspace);
  if (
    !workspace ||
    typeof workspace.cwd !== "string" ||
    typeof workspace.provider !== "string" ||
    !workspace.provider ||
    typeof workspace.permission_mode !== "string" ||
    !workspace.permission_mode ||
    !(
      workspace.project_id === undefined ||
      (typeof workspace.project_id === "string" && workspace.project_id.length > 0)
    ) ||
    !(
      workspace.project_name === undefined ||
      (typeof workspace.project_name === "string" &&
        workspace.project_name.length > 0)
    ) ||
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
  const fallbackProject = legacyProjectIdentity(workspaceCwd);
  const workspaceProjectId =
    typeof workspace.project_id === "string"
      ? workspace.project_id
      : fallbackProject.id;
  const workspaceProjectName =
    typeof workspace.project_name === "string"
      ? workspace.project_name
      : fallbackProject.name;
  const sessions: GatewaySessionSummary[] = parsedSessions.map((session) => {
    const cwd = session.rawCwd ?? workspaceCwd;
    const fallback = legacyProjectIdentity(cwd);
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      status: session.status,
      projectId: session.rawProjectId ?? fallback.id,
      projectName: session.rawProjectName ?? fallback.name,
      cwd,
      provider: session.provider,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort
        ? { reasoningEffort: session.reasoningEffort }
        : {}),
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
      projectId: workspaceProjectId,
      projectName: workspaceProjectName,
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
      status: session.status,
      project_id: session.projectId,
      project_name: session.projectName,
      cwd: session.cwd,
      provider: session.provider,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort
        ? { reasoning_effort: session.reasoningEffort }
        : {}),
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
    },
  };
}

function legacyProjectIdentity(cwd: string): { id: string; name: string } {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  const name =
    normalized === "/"
      ? "/"
      : normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  return {
    id: `legacy-project:${encodeURIComponent(normalized)}`,
    name,
  };
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
