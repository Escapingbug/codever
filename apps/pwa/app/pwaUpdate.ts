import { CODEVER_BUILD_VERSION } from "./buildInfo";

type UpdateRegistration = {
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

export type PwaUpdateEnvironment = {
  serviceWorker: UpdateServiceWorker;
  visibilityState(): string;
  addVisibilityListener(listener: () => void): void;
  removeVisibilityListener(listener: () => void): void;
  addOnlineListener(listener: () => void): void;
  removeOnlineListener(listener: () => void): void;
  reload(): void;
};

export function installPwaUpdateFlow(
  environment: PwaUpdateEnvironment,
  buildVersion = CODEVER_BUILD_VERSION,
): () => void {
  const hadController = Boolean(environment.serviceWorker.controller);
  let registration: UpdateRegistration | undefined;
  let disposed = false;
  let reloading = false;

  const checkForUpdate = () => {
    if (
      disposed ||
      environment.visibilityState() !== "visible" ||
      !registration
    ) {
      return;
    }
    void registration.update().catch(() => {
      // Offline use keeps the current worker until the next online check.
    });
  };
  const onControllerChange = () => {
    if (disposed || !hadController || reloading) return;
    reloading = true;
    environment.reload();
  };

  environment.serviceWorker.addEventListener(
    "controllerchange",
    onControllerChange,
  );
  environment.addVisibilityListener(checkForUpdate);
  environment.addOnlineListener(checkForUpdate);

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
      // Offline support is opportunistic in local preview environments.
    });

  return () => {
    disposed = true;
    environment.serviceWorker.removeEventListener(
      "controllerchange",
      onControllerChange,
    );
    environment.removeVisibilityListener(checkForUpdate);
    environment.removeOnlineListener(checkForUpdate);
  };
}

export function registerPwaUpdates(): () => void {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return () => {};
  }

  return installPwaUpdateFlow({
    serviceWorker: navigator.serviceWorker,
    visibilityState: () => document.visibilityState,
    addVisibilityListener: (listener) =>
      document.addEventListener("visibilitychange", listener),
    removeVisibilityListener: (listener) =>
      document.removeEventListener("visibilitychange", listener),
    addOnlineListener: (listener) => window.addEventListener("online", listener),
    removeOnlineListener: (listener) =>
      window.removeEventListener("online", listener),
    reload: () => window.location.reload(),
  });
}
