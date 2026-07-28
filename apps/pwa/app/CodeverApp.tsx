"use client";

import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Session = {
  id: string;
  initials: string;
  color: string;
  title: string;
  preview: string;
  time: string;
  unread?: number;
  active?: boolean;
  provider: string;
  model: string;
  repository: string;
  branch: string;
};

type ChatMessage = {
  id: string;
  kind: "notice" | "user" | "agent" | "tool" | "permission";
  text?: string;
  time?: string;
};

const sessions: Session[] = [
  {
    id: "matrix-rewrite",
    initials: "CV",
    color: "violet",
    title: "Matrix PWA rewrite",
    preview: "Waiting for permission to edit 3 files",
    time: "now",
    unread: 1,
    active: true,
    provider: "Codex",
    model: "GPT-5.2 Codex",
    repository: "escapingbug/codever",
    branch: "rewrite/matrix-pwa",
  },
  {
    id: "release",
    initials: "RL",
    color: "blue",
    title: "Prepare v0.4 release",
    preview: "All 128 tests passed. Ready to tag.",
    time: "10:42",
    provider: "Claude Code",
    model: "Claude Sonnet 4",
    repository: "codever/desktop",
    branch: "release/0.4",
  },
  {
    id: "security",
    initials: "SC",
    color: "green",
    title: "Security review",
    preview: "I found two places to harden nonce validation.",
    time: "Mon",
    unread: 3,
    provider: "Codex",
    model: "GPT-5.2 Codex",
    repository: "escapingbug/codever",
    branch: "security/device-trust",
  },
  {
    id: "ios",
    initials: "MB",
    color: "orange",
    title: "Mobile layout polish",
    preview: "The safe-area and keyboard fixes are in.",
    time: "Sun",
    provider: "Cursor Agent",
    model: "Composer",
    repository: "codever/pwa",
    branch: "feat/mobile-shell",
  },
  {
    id: "docs",
    initials: "DX",
    color: "pink",
    title: "Protocol documentation",
    preview: "Updated the encrypted envelope examples.",
    time: "Fri",
    provider: "OpenCode",
    model: "Gemini 3 Pro",
    repository: "codever/protocol",
    branch: "docs/envelopes",
  },
];

const initialMessages: ChatMessage[] = [
  {
    id: "notice",
    kind: "notice",
    text: "Messages and agent commands are end-to-end encrypted. Only your trusted devices can read or authorize them.",
  },
  {
    id: "user-1",
    kind: "user",
    text: "Build the first PWA screen from the architecture plan. Keep it familiar like Telegram, but make agent state and trust obvious.",
    time: "10:36",
  },
  {
    id: "agent-1",
    kind: "agent",
    text: "I’ll turn the starter into a responsive three-pane workspace, then add a local interaction model for sessions, permissions, and streaming responses.",
    time: "10:36",
  },
  { id: "tool-1", kind: "tool", time: "10:37" },
  {
    id: "agent-2",
    kind: "agent",
    text: "The app shell and mobile navigation are in place. I’m ready to update the PWA metadata and offline cache next.",
    time: "10:38",
  },
  { id: "permission-1", kind: "permission", time: "10:38" },
];

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <span className="icon" aria-hidden="true">
      {children}
    </span>
  );
}

export function CodeverApp() {
  const [selectedId, setSelectedId] = useState(sessions[0].id);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [permission, setPermission] = useState<
    "pending" | "approved" | "denied"
  >("pending");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [model, setModel] = useState(sessions[0].model);
  const [mode, setMode] = useState("Agent");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const responseDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected =
    sessions.find((session) => session.id === selectedId) ?? sessions[0];
  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) =>
        `${session.title} ${session.preview} ${session.repository}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [search],
  );

  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js").catch(() => {
      // Offline support is opportunistic in local preview environments.
    });
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, streamText, isStreaming]);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (responseDelayRef.current) clearTimeout(responseDelayRef.current);
    },
    [],
  );

  function chooseSession(id: string) {
    const next = sessions.find((session) => session.id === id);
    if (timerRef.current) clearInterval(timerRef.current);
    if (responseDelayRef.current) clearTimeout(responseDelayRef.current);
    timerRef.current = null;
    responseDelayRef.current = null;
    setIsStreaming(false);
    setStreamText("");
    setSelectedId(id);
    setModel(next?.model ?? sessions[0].model);
    setMobileChatOpen(true);
    if (id === sessions[0].id) {
      setPermission("pending");
      setMessages(initialMessages);
      return;
    }
    setPermission("approved");
    setMessages([
      {
        id: `${id}-notice`,
        kind: "notice",
        text: "This session is secured by your verified device keys.",
      },
      {
        id: `${id}-agent`,
        kind: "agent",
        text: next?.preview ?? "Session ready.",
        time: next?.time,
      },
    ]);
  }

  function startMockResponse() {
    const response =
      "I’m on it. I’ll inspect the current context, make the smallest safe change, and report back with the verification result.";
    let cursor = 0;
    setStreamText("");
    responseDelayRef.current = null;
    timerRef.current = setInterval(() => {
      cursor += 2;
      setStreamText(response.slice(0, cursor));
      if (cursor >= response.length) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setMessages((current) => [
          ...current,
          {
            id: `agent-${Date.now()}`,
            kind: "agent",
            text: response,
            time: "now",
          },
        ]);
        setStreamText("");
        setIsStreaming(false);
      }
    }, 28);
  }

  function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const value = draft.trim();
    if (!value || isStreaming) return;
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, kind: "user", text: value, time: "now" },
    ]);
    setDraft("");
    setIsStreaming(true);
    responseDelayRef.current = window.setTimeout(startMockResponse, 350);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  function stopStreaming() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (responseDelayRef.current) clearTimeout(responseDelayRef.current);
    timerRef.current = null;
    responseDelayRef.current = null;
    if (streamText) {
      setMessages((current) => [
        ...current,
        {
          id: `agent-stopped-${Date.now()}`,
          kind: "agent",
          text: `${streamText} — stopped`,
          time: "now",
        },
      ]);
    }
    setStreamText("");
    setIsStreaming(false);
  }

  return (
    <main className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""}`}>
      <aside className="rail" aria-label="Primary navigation">
        <div className="brand" title="Codever">
          <span>⌁</span>
        </div>
        <nav className="rail-nav">
          <button className="rail-button active" aria-label="Chats">
            <Icon>◫</Icon>
            <span>Chats</span>
          </button>
          <button className="rail-button" aria-label="Tasks">
            <Icon>✓</Icon>
            <span>Tasks</span>
          </button>
          <button className="rail-button" aria-label="Files">
            <Icon>▱</Icon>
            <span>Files</span>
          </button>
        </nav>
        <div className="rail-spacer" />
        <button className="rail-button" aria-label="Settings">
          <Icon>⚙</Icon>
          <span>Settings</span>
        </button>
        <div className="profile-avatar" title="Alex · verified device">
          AK
          <span className="presence-dot" />
        </div>
      </aside>

      <section className="session-panel" aria-label="Conversations">
        <header className="session-header">
          <div>
            <span className="eyebrow">Workspace</span>
            <h1>Codever</h1>
          </div>
          <button className="round-button" aria-label="New conversation">
            +
          </button>
        </header>

        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
          <kbd>⌘ K</kbd>
        </label>

        <div className="gateway-card">
          <span className="gateway-icon">G</span>
          <div>
            <strong>Studio Mac</strong>
            <span>
              <i /> Gateway online · 12 ms
            </span>
          </div>
          <button aria-label="Gateway options">•••</button>
        </div>

        <div className="session-section-label">
          <span>Recent</span>
          <span>{filteredSessions.length}</span>
        </div>

        <div className="session-list">
          {filteredSessions.map((session) => (
            <button
              key={session.id}
              className={`session-row ${
                selectedId === session.id ? "selected" : ""
              }`}
              onClick={() => chooseSession(session.id)}
            >
              <span className={`session-avatar ${session.color}`}>
                {session.initials}
                {session.active && <i className="agent-active" />}
              </span>
              <span className="session-copy">
                <span className="session-title-line">
                  <strong>{session.title}</strong>
                  <time>{session.time}</time>
                </span>
                <span className="session-preview-line">
                  <span>{session.preview}</span>
                  {session.unread && <b>{session.unread}</b>}
                </span>
              </span>
            </button>
          ))}
          {filteredSessions.length === 0 && (
            <div className="empty-search">
              <span>⌕</span>
              No matching conversations
            </div>
          )}
        </div>

        <footer className="trust-footer">
          <span className="shield">✓</span>
          <span>
            <strong>Encryption active</strong>
            <small>4 trusted devices</small>
          </span>
          <button aria-label="View trusted devices">›</button>
        </footer>
      </section>

      <section className="conversation-panel" aria-label={selected.title}>
        <header className="conversation-header">
          <button
            className="mobile-back"
            onClick={() => setMobileChatOpen(false)}
            aria-label="Back to conversations"
          >
            ‹
          </button>
          <span className={`conversation-avatar ${selected.color}`}>
            {selected.initials}
          </span>
          <div className="conversation-heading">
            <h2>{selected.title}</h2>
            <span>
              <i /> {selected.provider} is ready
            </span>
          </div>
          <div className="header-actions">
            <button className="header-button" aria-label="Search in conversation">
              ⌕
            </button>
            <button
              className={`header-button ${detailsOpen ? "pressed" : ""}`}
              aria-label="Conversation details"
              onClick={() => setDetailsOpen((value) => !value)}
            >
              ⋯
            </button>
          </div>
        </header>

        {detailsOpen && (
          <div className="details-popover">
            <span className="mini-label">Repository</span>
            <strong>{selected.repository}</strong>
            <span className="mini-label">Branch</span>
            <code>{selected.branch}</code>
            <span className="verified-line">
              <b>✓</b> Gateway identity verified
            </span>
          </div>
        )}

        <div className="chat-feed" ref={feedRef}>
          <div className="date-divider">
            <span>Today</span>
          </div>
          {messages.map((message) => {
            if (message.kind === "notice") {
              return (
                <div className="encryption-notice" key={message.id}>
                  <span className="shield">✓</span>
                  <span>{message.text}</span>
                </div>
              );
            }
            if (message.kind === "user") {
              return (
                <div className="message-row user-row" key={message.id}>
                  <div className="bubble user-bubble">
                    <p>{message.text}</p>
                    <time>
                      {message.time} <span>✓✓</span>
                    </time>
                  </div>
                </div>
              );
            }
            if (message.kind === "tool") {
              return (
                <div className="message-row agent-row" key={message.id}>
                  <div className="agent-mark">C</div>
                  <div className="tool-card">
                    <div className="tool-heading">
                      <span className="terminal-mark">&gt;_</span>
                      <span>
                        <strong>Inspect workspace</strong>
                        <small>Completed in 1.8s</small>
                      </span>
                      <b>✓</b>
                    </div>
                    <div className="tool-command">
                      <code>rg --files apps/pwa</code>
                    </div>
                    <button>View 24 files</button>
                  </div>
                </div>
              );
            }
            if (message.kind === "permission") {
              return (
                <div className="message-row agent-row" key={message.id}>
                  <div className="agent-mark">C</div>
                  <div className="permission-card">
                    <div className="permission-title">
                      <span>!</span>
                      <div>
                        <strong>Permission required</strong>
                        <small>Write access · 3 files</small>
                      </div>
                    </div>
                    <p>
                      Allow Codex to update the PWA screen, metadata, and offline
                      shell?
                    </p>
                    <div className="file-list">
                      <code>app/CodeverApp.tsx</code>
                      <code>app/globals.css</code>
                      <code>public/sw.js</code>
                    </div>
                    {permission === "pending" ? (
                      <div className="permission-actions">
                        <button
                          className="approve-button"
                          onClick={() => setPermission("approved")}
                        >
                          Allow once
                        </button>
                        <button
                          className="deny-button"
                          onClick={() => setPermission("denied")}
                        >
                          Deny
                        </button>
                      </div>
                    ) : (
                      <div className={`decision-state ${permission}`}>
                        {permission === "approved" ? "✓ Allowed once" : "× Denied"}
                      </div>
                    )}
                    <time>{message.time}</time>
                  </div>
                </div>
              );
            }
            return (
              <div className="message-row agent-row" key={message.id}>
                <div className="agent-mark">C</div>
                <div className="bubble agent-bubble">
                  <span className="agent-label">CODEX</span>
                  <p>{message.text}</p>
                  <time>{message.time}</time>
                </div>
              </div>
            );
          })}

          {isStreaming && (
            <div className="message-row agent-row streaming-row">
              <div className="agent-mark live">C</div>
              <div className="bubble agent-bubble">
                <span className="agent-label">
                  CODEX <i>responding</i>
                </span>
                <p>
                  {streamText}
                  <span className="cursor" />
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="composer-area">
          <div className="context-strip">
            <div className="context-item">
              <span className="context-icon">⌘</span>
              <span>
                <small>Repository</small>
                <b>{selected.repository}</b>
              </span>
            </div>
            <div className="context-item branch-item">
              <span className="branch-mark">⑂</span>
              <code>{selected.branch}</code>
            </div>
            <span className="context-spacer" />
            <span className="token-state">18k / 128k</span>
          </div>

          <form className="composer" onSubmit={sendMessage}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={`Message ${selected.provider}…`}
              aria-label={`Message ${selected.provider}`}
              rows={1}
            />
            <div className="composer-actions">
              <button
                type="button"
                className="attachment-button"
                aria-label="Attach a file"
              >
                +
              </button>
              <div className="agent-controls">
                <label>
                  <span className="status-spark" />
                  <select
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    aria-label="Agent model"
                  >
                    <option>GPT-5.2 Codex</option>
                    <option>Claude Sonnet 4</option>
                    <option>Gemini 3 Pro</option>
                    <option>Composer</option>
                  </select>
                </label>
                <span className="control-divider" />
                <label>
                  <select
                    value={mode}
                    onChange={(event) => setMode(event.target.value)}
                    aria-label="Agent mode"
                  >
                    <option>Agent</option>
                    <option>Plan</option>
                    <option>Ask</option>
                  </select>
                </label>
              </div>
              {isStreaming ? (
                <button
                  type="button"
                  className="send-button stop-button"
                  onClick={stopStreaming}
                  aria-label="Stop agent"
                >
                  ■
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  disabled={!draft.trim()}
                  aria-label="Send message"
                >
                  ↑
                </button>
              )}
            </div>
          </form>
          <p className="composer-hint">
            Enter to send · Shift + Enter for a new line
          </p>
        </div>
      </section>
    </main>
  );
}
