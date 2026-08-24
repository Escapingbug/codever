import {
  BridgeProtocolError,
  type ClientBootstrapResult,
  type HelloResult,
  type NativeUpdateStatus,
} from "@codever/native-bridge";
import { CODEVER_BUILD_VERSION } from "../buildInfo";
import { ConnectionFailureError } from "../connectionFailure";
import type { MatrixConnectionConfig } from "../matrix";
import type { CodeverClient, CodeverClientHandlers } from "./CodeverClient";
import {
  OPTIONAL_NATIVE_CAPABILITIES,
  REQUIRED_NATIVE_CAPABILITIES,
  hasCurrentNativeCapability,
  nativeCapabilityVersions,
  bootstrapNativeSession,
  createNativeBridgeClient,
  type NativeBootstrapInput,
} from "./native/NativeBridgeClient";
import {
  acquireNativeRpcBridge,
  NativeRpcBridge,
  injectedNativeBridgePort,
  type NativeBridgePort,
} from "./native/NativeRpcBridge";
import { createWebCodeverClient } from "./web/WebCodeverClient";

const NATIVE_FALLBACK_DETAIL =
  "This native host does not yet provide the complete Codever runtime; using the Web connection without background continuity.";
const WEB_SESSION_DETAIL =
  "This Matrix sign-in is owned by the browser. Use a Gateway device invitation to create a background-capable native session.";

export const NATIVE_MANAGED_ACCESS_TOKEN = "codever-native-managed-session-v1";

export type CreateCodeverClientDependencies = {
  nativePort(): NativeBridgePort | null;
  createWeb: typeof createWebCodeverClient;
  createBridge(port: NativeBridgePort):
    | NativeRpcBridge
    | Promise<NativeRpcBridge>;
};

const defaultDependencies: CreateCodeverClientDependencies = {
  nativePort: () => injectedNativeBridgePort(),
  createWeb: createWebCodeverClient,
  createBridge: (port) => acquireNativeRpcBridge(port),
};

/**
 * Selects native only after every domain capability required by CodeverClient
 * was negotiated. An older/partial host remains usable, but the UI explicitly
 * reports that its Matrix transport is the foreground Web implementation.
 */
export async function createCodeverClient(
  config: MatrixConnectionConfig,
  handlers: CodeverClientHandlers,
  dependencies: CreateCodeverClientDependencies = defaultDependencies,
): Promise<CodeverClient> {
  const nativeManaged = isNativeManagedMatrixConfig(config);
  const port = dependencies.nativePort();
  if (!port) {
    handlers.onNativeRuntime?.(null);
    if (nativeManaged) throw nativeRuntimeUnavailable();
    return dependencies.createWeb(config, handlers);
  }

  const bridge = await dependencies.createBridge(port);
  let hello: HelloResult;
  try {
    hello = await bridge.hello({
      webBuild: CODEVER_BUILD_VERSION,
      requiredCapabilities: [],
      optionalCapabilities: [
        ...REQUIRED_NATIVE_CAPABILITIES,
        ...OPTIONAL_NATIVE_CAPABILITIES,
      ].map((name) => ({
        name,
        versions: nativeCapabilityVersions(name),
      })),
    });
  } catch (error) {
    bridge.close();
    handlers.onNativeRuntime?.(null);
    if (nativeManaged) throw nativeRuntimeUnavailable(error);
    handlers.onStatus(
      "connecting",
      `${NATIVE_FALLBACK_DETAIL} Native handshake failed: ${formatError(error)}`,
    );
    return dependencies.createWeb(config, handlers);
  }
  handlers.onNativeRuntime?.(hello.native);
  const fullNative = REQUIRED_NATIVE_CAPABILITIES.every(
    (name) => hasCurrentNativeCapability(hello, name),
  );
  if (fullNative && nativeManaged) {
    // Once a runtime claims the complete durable domain, startup failures are
    // fail-closed. Falling back could create a second Matrix device/command.
    return createNativeBridgeClient(bridge, hello, handlers);
  }
  bridge.close();
  if (fullNative) {
    handlers.onStatus("connecting", WEB_SESSION_DETAIL);
    return dependencies.createWeb(config, handlers);
  }
  if (nativeManaged) throw nativeRuntimeOutdated();
  handlers.onStatus("connecting", NATIVE_FALLBACK_DETAIL);
  return dependencies.createWeb(config, handlers);
}

/**
 * Keeps native app recovery available even when the installed shell is too old
 * to construct the full durable Codever client. The update capability has its
 * own short-lived bridge lease so a compatibility failure never leaves the
 * user with diagnostics as the only possible action.
 */
export async function advanceNativeAppUpdate(
  options: {
    installReady?: boolean;
    dependencies?: Pick<
      CreateCodeverClientDependencies,
      "nativePort" | "createBridge"
    >;
  } = {},
): Promise<NativeUpdateStatus> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const port = dependencies.nativePort();
  if (!port) {
    throw new BridgeProtocolError(
      "BRIDGE_NOT_READY",
      "The native app did not answer the update request.",
      { retryable: true, userAction: "update_native" },
    );
  }
  const bridge = await dependencies.createBridge(port);
  try {
    const hello = await bridge.hello({
      webBuild: CODEVER_BUILD_VERSION,
      requiredCapabilities: [{ name: "client.update", versions: [1] }],
    });
    if (hello.capabilities["client.update"]?.version !== 1) {
      throw new BridgeProtocolError(
        "CAPABILITY_UNAVAILABLE",
        "This APK cannot install direct native updates.",
        { userAction: "update_native" },
      );
    }
    const status = await bridge.request("codever.update.status", {
      context: bridge.context(),
    });
    if (
      options.installReady === false ||
      (status.phase !== "ready" && status.phase !== "permission_required")
    ) {
      return status;
    }
    return await bridge.request("codever.update.install", {
      context: bridge.context(),
      idempotencyKey: crypto.randomUUID(),
    });
  } finally {
    bridge.close();
  }
}

/**
 * Consumes a one-time Matrix login token in native code only when the host
 * implements the complete durable Codever runtime. A partial/older host leaves
 * the token untouched so the browser implementation may consume it instead.
 */
export async function bootstrapNativeMatrixSessionIfAvailable(
  input: NativeBootstrapInput,
  dependencies: Pick<
    CreateCodeverClientDependencies,
    "nativePort" | "createBridge"
  > = defaultDependencies,
): Promise<ClientBootstrapResult | null> {
  const port = dependencies.nativePort();
  if (!port) return null;
  const bridge = await dependencies.createBridge(port);
  try {
    const hello = await bridge.hello({
      webBuild: CODEVER_BUILD_VERSION,
      requiredCapabilities: [],
      optionalCapabilities: [
        ...REQUIRED_NATIVE_CAPABILITIES,
        ...OPTIONAL_NATIVE_CAPABILITIES,
      ].map((name) => ({
        name,
        versions: nativeCapabilityVersions(name),
      })),
    });
    if (
      !REQUIRED_NATIVE_CAPABILITIES.every(
        (name) => hasCurrentNativeCapability(hello, name),
      )
    ) {
      return null;
    }
    return await bootstrapNativeSession(bridge, input);
  } finally {
    bridge.close();
  }
}

export function isNativeManagedMatrixConfig(
  config: MatrixConnectionConfig,
): boolean {
  return config.accessToken === NATIVE_MANAGED_ACCESS_TOKEN;
}

function nativeRuntimeUnavailable(cause?: unknown): Error {
  return new ConnectionFailureError(
    "matrix_native_runtime_unavailable",
    "This Matrix session is owned by the native runtime, but the installed native host is unavailable or incompatible. Update or reopen the native app; Codever will not create a duplicate Web Matrix device.",
    cause === undefined ? undefined : { cause },
  );
}

function nativeRuntimeOutdated(): Error {
  return new ConnectionFailureError(
    "matrix_native_runtime_outdated",
    "This Matrix session needs a newer native runtime. Update the native app; Codever will not create a duplicate Web Matrix device.",
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
