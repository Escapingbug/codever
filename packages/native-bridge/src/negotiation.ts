import { BridgeProtocolError } from "./errors.js";
import {
  NATIVE_BRIDGE_LIMITS,
  type HelloParams,
  type HelloResult,
  type JsonObject,
  type NegotiatedCapability,
} from "./types.js";

export type CapabilitySupport = {
  versions: readonly number[];
  options?: JsonObject;
};

export type NativeBridgeSupport = {
  protocolVersions: readonly number[];
  native: HelloResult["native"];
  capabilities: Readonly<Record<string, CapabilitySupport>>;
};

/**
 * Selects the highest mutually supported bridge and capability versions.
 * Missing optional capabilities are omitted; a missing required capability
 * fails closed so an online UI cannot silently fall back to a weaker path.
 */
export function negotiateHello(
  hello: HelloParams,
  support: NativeBridgeSupport,
  bridgeSessionId: string,
): HelloResult {
  if (bridgeSessionId.length === 0 || bridgeSessionId.length > 256) {
    throw new BridgeProtocolError(
      "INVALID_STATE",
      "The native bridge session identifier is invalid.",
    );
  }

  const protocolVersion = highestCommonVersion(
    hello.supportedProtocolVersions,
    support.protocolVersions,
  );
  if (protocolVersion === undefined) {
    throw new BridgeProtocolError(
      "PROTOCOL_UNSUPPORTED",
      "The Web UI and native runtime do not share a bridge protocol version.",
      { userAction: "update_native" },
    );
  }

  const requiredNames = new Set(
    hello.requiredCapabilities.map(({ name }) => name),
  );
  for (const { name } of hello.optionalCapabilities) {
    if (requiredNames.has(name)) {
      throw new BridgeProtocolError(
        "INVALID_PARAMS",
        `Capability ${name} cannot be both required and optional.`,
      );
    }
  }

  const capabilities: Record<string, NegotiatedCapability> = {};
  for (const request of hello.requiredCapabilities) {
    const selected = negotiateCapability(request, support.capabilities[request.name]);
    if (!selected) {
      throw new BridgeProtocolError(
        "CAPABILITY_UNAVAILABLE",
        `Required native capability is unavailable: ${request.name}.`,
        { userAction: "update_native" },
      );
    }
    capabilities[request.name] = selected;
  }
  for (const request of hello.optionalCapabilities) {
    const selected = negotiateCapability(request, support.capabilities[request.name]);
    if (selected) capabilities[request.name] = selected;
  }

  return {
    protocolVersion,
    bridgeSessionId,
    native: support.native,
    capabilities,
    limits: NATIVE_BRIDGE_LIMITS,
  };
}

export function highestCommonVersion(
  requested: readonly number[],
  supported: readonly number[],
): number | undefined {
  const supportedSet = new Set(supported);
  return [...requested]
    .filter((version) => Number.isSafeInteger(version) && supportedSet.has(version))
    .sort((left, right) => right - left)[0];
}

function negotiateCapability(
  request: { name: string; versions: readonly number[] },
  support: CapabilitySupport | undefined,
): NegotiatedCapability | undefined {
  if (!support) return undefined;
  const version = highestCommonVersion(request.versions, support.versions);
  if (version === undefined) return undefined;
  return {
    version,
    ...(support.options === undefined ? {} : { options: support.options }),
  };
}
