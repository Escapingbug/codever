"use client";

import { useEffect, useRef } from "react";
import type { GatewaySessionSummary } from "./gatewayState";

type Props = {
  session: GatewaySessionSummary | null;
  busy: boolean;
  onClose(): void;
  onConfirm(): void;
};

export function SessionDeleteDialog({
  session,
  busy,
  onClose,
  onConfirm,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!session) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, session]);

  if (!session) return null;

  return (
    <div
      className="new-session-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <section
        className="session-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-delete-title"
        aria-describedby="session-delete-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="danger-symbol" aria-hidden="true">
          !
        </div>
        <span className="eyebrow">Permanent action</span>
        <h2 id="session-delete-title">Delete “{session.title}”?</h2>
        <p id="session-delete-description">
          This removes the session from Codever on every connected device
          {session.status === "archived"
            ? "."
            : " and stops its agent if it is still running."}
        </p>
        <div className="delete-boundary-note">
          Copies already stored by your account provider or coding agent are
          not erased.
        </div>
        <footer>
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {busy ? "Deleting…" : "Delete session"}
          </button>
        </footer>
      </section>
    </div>
  );
}
