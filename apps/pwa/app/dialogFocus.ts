"use client";

import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type DialogFocusOptions = {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  escapeDisabled?: boolean;
  onEscape(): void;
};

/**
 * Gives a modal predictable keyboard behavior without coupling it to a
 * particular dialog implementation. Only the last rendered modal handles
 * keys, so a nested scanner cannot close or move focus in its parent dialog.
 */
export function useDialogFocus({
  open,
  containerRef,
  initialFocusRef,
  escapeDisabled = false,
  onEscape,
}: DialogFocusOptions): void {
  const onEscapeRef = useRef(onEscape);
  const escapeDisabledRef = useRef(escapeDisabled);

  useEffect(() => {
    onEscapeRef.current = onEscape;
    escapeDisabledRef.current = escapeDisabled;
  }, [escapeDisabled, onEscape]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const container = containerRef.current;
    if (!container) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusFrame = window.requestAnimationFrame(() => {
      const initialFocus = initialFocusRef?.current;
      if (initialFocus && isFocusable(initialFocus)) {
        initialFocus.focus();
        return;
      }
      const [firstFocusable] = getFocusableElements(container);
      (firstFocusable ?? container).focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal(container)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!escapeDisabledRef.current) onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const target = resolveFocusTrapTarget(
        focusable,
        document.activeElement,
        event.shiftKey,
      );
      if (!target) return;
      event.preventDefault();
      target.focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      window.requestAnimationFrame(() => {
        if (previousFocus?.isConnected) previousFocus.focus();
      });
    };
  }, [containerRef, initialFocusRef, open]);
}

export function resolveFocusTrapTarget<T>(
  focusable: readonly T[],
  activeElement: unknown,
  backwards: boolean,
): T | null {
  if (focusable.length === 0) return null;
  const activeIndex = focusable.indexOf(activeElement as T);
  if (activeIndex === -1) {
    return backwards ? focusable[focusable.length - 1] : focusable[0];
  }
  if (!backwards && activeIndex === focusable.length - 1) {
    return focusable[0];
  }
  if (backwards && activeIndex === 0) {
    return focusable[focusable.length - 1];
  }
  return null;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    isFocusable,
  );
}

function isFocusable(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    !element.hasAttribute("disabled") &&
    element.getAttribute("aria-hidden") !== "true" &&
    element.getAttribute("tabindex") !== "-1" &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}

function isTopmostModal(container: HTMLElement): boolean {
  const modals = document.querySelectorAll<HTMLElement>(
    "[role='dialog'][aria-modal='true'], [role='alertdialog'][aria-modal='true']",
  );
  return modals.length === 0 || modals[modals.length - 1] === container;
}
