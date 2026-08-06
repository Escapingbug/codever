"use client";

import { useLayoutEffect, useRef } from "react";

export const NATIVE_BACK_EVENT = "codever:native-back";

export const NATIVE_BACK_PRIORITY = {
  app: 0,
  nestedModal: 100,
} as const;

export type NativeBackHandler = () => boolean;

type NativeBackRegistration = {
  id: number;
  priority: number;
  handler: NativeBackHandler;
};

/**
 * Keeps native Back handling independent from browser history. The highest
 * priority visible UI layer gets the first opportunity to consume the event.
 */
export class NativeBackDispatcher {
  readonly #handlers = new Map<number, NativeBackRegistration>();
  #nextId = 0;

  register(handler: NativeBackHandler, priority = 0): () => void {
    const id = ++this.#nextId;
    this.#handlers.set(id, { id, priority, handler });
    return () => this.#handlers.delete(id);
  }

  dispatch(): boolean {
    const handlers = [...this.#handlers.values()].sort(
      (left, right) => right.priority - left.priority || right.id - left.id,
    );
    for (const registration of handlers) {
      if (registration.handler()) return true;
    }
    return false;
  }

  get size(): number {
    return this.#handlers.size;
  }
}

export type CodeverBackState = {
  deleteDialogOpen: boolean;
  deleteDialogBusy: boolean;
  newSessionOpen: boolean;
  newSessionBusy: boolean;
  settingsOpen: boolean;
  detailsOpen: boolean;
  mobileChatOpen: boolean;
};

export type CodeverBackAction =
  | "close-delete-dialog"
  | "block-delete-dialog"
  | "close-new-session"
  | "block-new-session"
  | "close-settings"
  | "close-details"
  | "show-conversations";

export function resolveCodeverBackAction(
  state: CodeverBackState,
): CodeverBackAction | null {
  if (state.deleteDialogOpen) {
    return state.deleteDialogBusy
      ? "block-delete-dialog"
      : "close-delete-dialog";
  }
  if (state.newSessionOpen) {
    return state.newSessionBusy
      ? "block-new-session"
      : "close-new-session";
  }
  if (state.settingsOpen) return "close-settings";
  if (state.detailsOpen) return "close-details";
  if (state.mobileChatOpen) return "show-conversations";
  return null;
}

const nativeBackDispatcher = new NativeBackDispatcher();
let listening = false;

function onNativeBack(event: Event): void {
  if (event.defaultPrevented) return;
  if (nativeBackDispatcher.dispatch()) event.preventDefault();
}

function ensureNativeBackListener(): void {
  if (listening || typeof window === "undefined") return;
  window.addEventListener(NATIVE_BACK_EVENT, onNativeBack);
  listening = true;
}

function removeNativeBackListenerIfIdle(): void {
  if (!listening || nativeBackDispatcher.size !== 0) return;
  window.removeEventListener(NATIVE_BACK_EVENT, onNativeBack);
  listening = false;
}

export function registerNativeBackHandler(
  handler: NativeBackHandler,
  priority = 0,
): () => void {
  ensureNativeBackListener();
  const unregister = nativeBackDispatcher.register(handler, priority);
  return () => {
    unregister();
    removeNativeBackListenerIfIdle();
  };
}

export function useNativeBackHandler(
  enabled: boolean,
  handler: NativeBackHandler,
  priority = 0,
): void {
  const handlerRef = useRef(handler);

  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useLayoutEffect(() => {
    if (!enabled) return;
    return registerNativeBackHandler(() => handlerRef.current(), priority);
  }, [enabled, priority]);
}
