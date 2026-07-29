export type GatewayCapabilityOption = {
  id: string;
  name: string;
};

export type GatewaySessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  provider: string;
  model?: string;
};

export type GatewayWorkspaceState = {
  cwd: string;
  provider: string;
  model?: string;
  permissionMode: string;
};

export type GatewayCapabilities = {
  models: GatewayCapabilityOption[];
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

  const sessions = extension.sessions.map((value) => {
    const session = asRecord(value);
    if (
      !session ||
      typeof session.id !== "string" ||
      !session.id ||
      typeof session.title !== "string" ||
      !session.title ||
      !isNonnegativeInteger(session.updated_at) ||
      typeof session.provider !== "string" ||
      !session.provider ||
      !(
        session.model === undefined ||
        (typeof session.model === "string" && session.model.length > 0)
      )
    ) {
      throw new Error("The authenticated Gateway session summary is malformed.");
    }
    return {
      id: session.id,
      title: session.title,
      updatedAt: session.updated_at,
      provider: session.provider,
      ...(typeof session.model === "string" ? { model: session.model } : {}),
    } satisfies GatewaySessionSummary;
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
      workspace.model === undefined ||
      (typeof workspace.model === "string" && workspace.model.length > 0)
    )
  ) {
    throw new Error("The authenticated Gateway workspace state is malformed.");
  }

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
      cwd: workspace.cwd,
      provider: workspace.provider,
      ...(typeof workspace.model === "string"
        ? { model: workspace.model }
        : {}),
      permissionMode: workspace.permission_mode,
    },
    capabilities: {
      models: parseOptions(capabilities.models, "model"),
      permissionModes: parseOptions(
        capabilities.permission_modes,
        "permission mode",
      ),
      canCreateSession: capabilities.can_create_session,
      canSelectSession: capabilities.can_select_session,
    },
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
