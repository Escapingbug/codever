"use client";

import { FormEvent, useRef, useState } from "react";
import type {
  ProviderHistoryMessage,
  ProviderSessionEntry,
} from "@codever/protocol";
import { MarkdownContent } from "./MarkdownContent";
import { useDialogFocus } from "./dialogFocus";

type ProviderOption = {
  id: string;
  name: string;
  canListSessions: boolean;
  canInspectSessions: boolean;
};

type Props = {
  open: boolean;
  provider: string;
  providers: ProviderOption[];
  sessions: ProviderSessionEntry[];
  selected: ProviderSessionEntry | null;
  messages: ProviderHistoryMessage[];
  loading: "sessions" | "session" | null;
  error: string | null;
  onClose(): void;
  onProviderChange(provider: string): void;
  onInspect(session: ProviderSessionEntry): void;
  onRetry(): void;
  onOpenManaged(sessionId: string): void;
  onContinue(session: ProviderSessionEntry, text: string): void;
};

export function ProviderHistoryDialog(props: Props) {
  if (!props.open) return null;
  return <ProviderHistoryDialogContent {...props} />;
}

function ProviderHistoryDialogContent({
  open,
  provider,
  providers,
  sessions,
  selected,
  messages,
  loading,
  error,
  onClose,
  onProviderChange,
  onInspect,
  onRetry,
  onOpenManaged,
  onContinue,
}: Props) {
  const draftKey = `${provider}\u0000${selected?.sessionId ?? ""}`;
  const [draftState, setDraftState] = useState({ key: draftKey, text: "" });
  const draft = draftState.key === draftKey ? draftState.text : "";
  const dialogRef = useRef<HTMLElement>(null);
  const providerRef = useRef<HTMLSelectElement>(null);
  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: providerRef,
    onEscape: onClose,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!selected || !text || loading === "session") return;
    setDraftState({ key: draftKey, text: "" });
    onContinue(selected, text);
  };

  return (
    <div
      className="new-session-backdrop provider-history-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={dialogRef}
        className="provider-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-history-title"
        aria-busy={loading !== null}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Provider-owned history</span>
            <h2 id="provider-history-title">Provider sessions</h2>
            <p>Browse first. Sending a message adopts the session into Codever.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close provider history">×</button>
        </header>

        <div className="provider-history-toolbar">
          <label>
            <span>Provider</span>
            <select
              ref={providerRef}
              value={provider}
              disabled={loading !== null}
              onChange={(event) => onProviderChange(event.target.value)}
            >
              {providers.map(option => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </label>
          <small>
            {loading === "sessions"
              ? sessions.length === 0
                ? "Loading provider sessions in the background…"
                : "Refreshing provider sessions in the background…"
              : "Archiving in Codever never removes these provider copies."}
          </small>
        </div>

        <div className="provider-history-body">
          <aside aria-label="Provider session list">
            {sessions.map(session => (
              <button
                type="button"
                key={session.sessionId}
                className={selected?.sessionId === session.sessionId ? "selected" : ""}
                onClick={() => onInspect(session)}
                disabled={loading !== null}
              >
                <strong>{session.title}</strong>
                <small>
                  {session.managedSessionId ? "Open in Codever" : "Provider session"}
                  {session.updatedAt ? ` · ${new Date(session.updatedAt).toLocaleString()}` : ""}
                </small>
              </button>
            ))}
            {loading === "sessions" && sessions.length === 0 && (
              <p className="provider-history-empty">Loading provider sessions…</p>
            )}
            {loading === null && sessions.length === 0 && (
              <p className="provider-history-empty">No sessions were reported for this project.</p>
            )}
          </aside>

          <section className="provider-history-preview">
            {error && (
              <div className="provider-history-error" role="alert">
                <p>{error}</p>
                <button type="button" onClick={onRetry} disabled={loading !== null}>
                  Retry
                </button>
              </div>
            )}
            {loading === "session" && <p className="provider-history-empty">Loading session history…</p>}
            {loading !== "session" && selected && (
              <>
                <header>
                  <div>
                    <strong>{selected.title}</strong>
                    <small>{selected.cwd || provider}</small>
                  </div>
                  {selected.managedSessionId && (
                    <button type="button" onClick={() => onOpenManaged(selected.managedSessionId!)}>
                      Open current session
                    </button>
                  )}
                </header>
                <div className="provider-history-messages">
                  {messages.map(message => (
                    <article key={message.id} className={`provider-history-message ${message.role}`}>
                      <span>{message.role === "user" ? "You" : provider}</span>
                      <MarkdownContent content={message.text} />
                    </article>
                  ))}
                  {messages.length === 0 && (
                    <p className="provider-history-empty">This provider returned no readable message content.</p>
                  )}
                </div>
                {!selected.managedSessionId && (
                  <form className="provider-history-composer" onSubmit={submit}>
                    <textarea
                      value={draft}
                      onChange={(event) => setDraftState({ key: draftKey, text: event.target.value })}
                      placeholder="Continue this provider session in Codever"
                      rows={2}
                    />
                    <button type="submit" disabled={!draft.trim() || loading === "session"}>
                      Continue in Codever
                    </button>
                  </form>
                )}
              </>
            )}
            {loading === null && !selected && !error && (
              <p className="provider-history-empty">Choose a provider session to inspect it.</p>
            )}
            {loading === "sessions" && !selected && (
              <p className="provider-history-empty">You can close this window while sessions load.</p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
