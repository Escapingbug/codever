import { CODEVER_BUILD_VERSION } from "./buildInfo";

const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;
const UPDATE_MARKER_KEY = "codever:pwa-update-from";
const UPDATE_QUERY_KEY = "__codever_build";

type UpdateWorker = {
  postMessage(message: unknown): void;
};

type UpdateRegistration = {
  waiting?: UpdateWorker | null;
  update(): Promise<unknown>;
};

type UpdateServiceWorker = {
  controller: unknown;
  register(
    scriptURL: string,
    options: { updateViaCache: "none" },
  ): Promise<UpdateRegistration>;
  addEventListener(type: "controllerchange", listener: () => void): void;
  removeEventListener(type: "controllerchange", listener: () => void): void;
};

export type PwaUpdateState =
  | {
      phase: "current";
      currentVersion: string;
      checkedAt?: number;
    }
  | {
      phase: "checking";
      currentVersion: string;
    }
  | {
      phase: "updating";
      currentVersion: string;
      latestVersion: string;
    }
  | {
      phase: "waiting";
      currentVersion: string;
      latestVersion: string;
    }
  | {
      phase: "updated";
      currentVersion: string;
      previousVersion: string;
    }
  | {
      phase: "unavailable";
      currentVersion: string;
    };

export type PwaUpdateHandle = {
  checkNow(): Promise<void>;
  resumeDeferredUpdate(): void;
  dismissUpdatedNotice(): void;
  dispose(): void;
};

export type PwaUpdateEnvironment = {
  serviceWorker: UpdateServiceWorker;
  visibilityState(): string;
  addVisibilityListener(listener: () => void): void;
  removeVisibilityListener(listener: () => void): void;
  addOnlineListener(listener: () => void): void;
  removeOnlineListener(listener: () => void): void;
  fetchLatestBuild(currentVersion: string): Promise<string>;
  readUpdateMarker(): string | null;
  writeUpdateMarker(version: string): void;
  clearUpdateMarker(): void;
  clearUpdateQuery(): void;
  canReload(): boolean;
  reloadToBuild(version: string): void;
  startPeriodicCheck(listener: () => void, intervalMs: number): number;
  stopPeriodicCheck(timer: number): void;
  now(): number;
};

export function installPwaUpdateFlow(
  environment: PwaUpdateEnvironment,
  buildVersion = CODEVER_BUILD_VERSION,
  onStateChange: (state: PwaUpdateState) => void = () => {},
): PwaUpdateHandle {
  const hadController = Boolean(environment.serviceWorker.controller);
  const previousVersion = environment.readUpdateMarker();
  let registration: UpdateRegistration | undefined;
  let disposed = false;
  let reloading = false;
  let targetVersion = buildVersion;
  let checkInFlight: Promise<void> | null = null;
  let state: PwaUpdateState =
    previousVersion && previousVersion !== buildVersion
      ? { phase: "updated", currentVersion: buildVersion, previousVersion }
      : { phase: "current", currentVersion: buildVersion };

  environment.clearUpdateMarker();
  environment.clearUpdateQuery();
  onStateChange(state);

  const publish = (next: PwaUpdateState) => {
    state = next;
    if (!disposed) onStateChange(next);
  };
  const requestWorkerUpdate = async () => {
    if (!registration) return;
    try {
      await registration.update();
      registration.waiting?.postMessage({ type: "SKIP_WAITING" });
    } catch {
      // The version endpoint remains authoritative. A network navigation below
      // still replaces the hashed application shell when worker update fails.
    }
  };
  const reload = (version: string) => {
    if (disposed || reloading) return;
    targetVersion = version;
    if (!environment.canReload()) {
      publish({
        phase: "waiting",
        currentVersion: buildVersion,
        latestVersion: version,
      });
      return;
    }
    reloading = true;
    environment.writeUpdateMarker(buildVersion);
    environment.reloadToBuild(version);
  };
  const checkLatest = (announce: boolean): Promise<void> => {
    if (disposed || environment.visibilityState() !== "visible") {
      return Promise.resolve();
    }
    if (checkInFlight) return checkInFlight;
    if (announce) {
      publish({ phase: "checking", currentVersion: buildVersion });
    }
    checkInFlight = (async () => {
      try {
        const latestVersion = validateBuildVersion(
          await environment.fetchLatestBuild(buildVersion),
        );
        if (latestVersion !== buildVersion) {
          targetVersion = latestVersion;
          publish({
            phase: "updating",
            currentVersion: buildVersion,
            latestVersion,
          });
          void requestWorkerUpdate();
          reload(latestVersion);
          return;
        }
        if (announce || state.phase !== "updated") {
          publish({
            phase: "current",
            currentVersion: buildVersion,
            checkedAt: environment.now(),
          });
        }
      } catch {
        if (announce) {
          publish({ phase: "unavailable", currentVersion: buildVersion });
        }
      } finally {
        checkInFlight = null;
      }
    })();
    return checkInFlight;
  };
  const checkForUpdate = () => {
    if (disposed || environment.visibilityState() !== "visible") return;
    void requestWorkerUpdate();
    void checkLatest(false);
  };
  const onControllerChange = () => {
    if (disposed || !hadController || reloading) return;
    reload(targetVersion);
  };

  environment.serviceWorker.addEventListener(
    "controllerchange",
    onControllerChange,
  );
  environment.addVisibilityListener(checkForUpdate);
  environment.addOnlineListener(checkForUpdate);
  const periodicTimer = environment.startPeriodicCheck(
    checkForUpdate,
    UPDATE_CHECK_INTERVAL_MS,
  );

  void environment.serviceWorker
    .register(
      `/sw.js?v=${encodeURIComponent(buildVersion)}`,
      { updateViaCache: "none" },
    )
    .then((nextRegistration) => {
      if (disposed) return;
      registration = nextRegistration;
      checkForUpdate();
    })
    .catch(() => {
      // A direct version check and navigation can still update the app even
      // when service workers are unavailable in a preview or browser policy.
      void checkLatest(false);
    });

  return {
    checkNow: () => checkLatest(true),
    resumeDeferredUpdate: () => {
      if (state.phase === "waiting") reload(targetVersion);
    },
    dismissUpdatedNotice: () => {
      if (state.phase === "updated") {
        publish({ phase: "current", currentVersion: buildVersion });
      }
    },
    dispose: () => {
      disposed = true;
      environment.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
      environment.removeVisibilityListener(checkForUpdate);
      environment.removeOnlineListener(checkForUpdate);
      environment.stopPeriodicCheck(periodicTimer);
    },
  };
}

export function registerPwaUpdates(
  onStateChange?: (state: PwaUpdateState) => void,
  options?: { canReload?: () => boolean },
): PwaUpdateHandle {
  if (typeof navigator === "undefined") {
    return inertUpdateHandle();
  }

  const serviceWorker: UpdateServiceWorker =
    "serviceWorker" in navigator
      ? navigator.serviceWorker
      : {
          controller: null,
          register: async () => {
            throw new Error("Service workers are unavailable.");
          },
          addEventListener: () => {},
          removeEventListener: () => {},
        };

  return installPwaUpdateFlow(
    {
      serviceWorker,
      visibilityState: () => document.visibilityState,
      addVisibilityListener: (listener) =>
        document.addEventListener("visibilitychange", listener),
      removeVisibilityListener: (listener) =>
        document.removeEventListener("visibilitychange", listener),
      addOnlineListener: (listener) => window.addEventListener("online", listener),
      removeOnlineListener: (listener) =>
        window.removeEventListener("online", listener),
      fetchLatestBuild: fetchLatestBuildVersion,
      readUpdateMarker: readUpdateMarker,
      writeUpdateMarker: writeUpdateMarker,
      clearUpdateMarker: clearUpdateMarker,
      clearUpdateQuery: clearUpdateQuery,
      canReload: options?.canReload ?? (() => true),
      reloadToBuild: reloadToBuild,
      startPeriodicCheck: (listener, intervalMs) =>
        window.setInterval(listener, intervalMs),
      stopPeriodicCheck: (timer) => window.clearInterval(timer),
      now: () => Date.now(),
    },
    CODEVER_BUILD_VERSION,
    onStateChange,
  );
}

async function fetchLatestBuildVersion(currentVersion: string): Promise<string> {
  const url = new URL("/api/version", window.location.origin);
  url.searchParams.set("current", currentVersion);
  url.searchParams.set("request", crypto.randomUUID());
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Update check failed with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Update response is invalid.");
  }
  return validateBuildVersion((body as Record<string, unknown>).buildVersion);
}

function validateBuildVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 80 ||
    !/^[A-Za-z0-9._+-]+$/u.test(value)
  ) {
    throw new Error("Update response contains an invalid build version.");
  }
  return value;
}

function reloadToBuild(version: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(UPDATE_QUERY_KEY, version);
  window.location.replace(url.toString());
}

function clearUpdateQuery(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(UPDATE_QUERY_KEY)) return;
  url.searchParams.delete(UPDATE_QUERY_KEY);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function readUpdateMarker(): string | null {
  try {
    return window.sessionStorage.getItem(UPDATE_MARKER_KEY);
  } catch {
    return null;
  }
}

function writeUpdateMarker(version: string): void {
  try {
    window.sessionStorage.setItem(UPDATE_MARKER_KEY, version);
  } catch {
    // Reloading to the authoritative build is more important than the optional
    // post-update notice in browsers that disable session storage.
  }
}

function clearUpdateMarker(): void {
  try {
    window.sessionStorage.removeItem(UPDATE_MARKER_KEY);
  } catch {
    // Storage can be unavailable in hardened private browsing modes.
  }
}

function inertUpdateHandle(): PwaUpdateHandle {
  return {
    checkNow: async () => {},
    resumeDeferredUpdate: () => {},
    dismissUpdatedNotice: () => {},
    dispose: () => {},
  };
}
