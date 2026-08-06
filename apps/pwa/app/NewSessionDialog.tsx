"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import type {
  JsonValue,
  SessionExtensionBinding,
  SessionExtensionDescriptor,
} from "@codever/protocol";
import { useDialogFocus } from "./dialogFocus";
import {
  gatewayProjectKey,
  type GatewayModelCapability,
  type GatewaySessionSummary,
  type GatewayWorkspaceState,
} from "./gatewayState";

type NewSessionInput = {
  cwd: string;
  projectName: string;
  model?: string;
  reasoningEffort?: string;
  extensions?: SessionExtensionBinding[];
};

type Props = {
  open: boolean;
  busy: boolean;
  gatewayId: string;
  gatewayName: string;
  workspace: GatewayWorkspaceState;
  sessions: GatewaySessionSummary[];
  models: GatewayModelCapability[];
  extensions: SessionExtensionDescriptor[];
  onClose(): void;
  onCreate(input: NewSessionInput): void;
};

const NEW_PROJECT = "__new_project__";

export function NewSessionDialog(props: Props) {
  if (!props.open) return null;
  return <NewSessionDialogContent {...props} />;
}

function NewSessionDialogContent({
  open,
  busy,
  gatewayId,
  gatewayName,
  workspace,
  sessions,
  models,
  extensions,
  onClose,
  onCreate,
}: Props) {
  const projects = useMemo(() => {
    const values = new Map<
      string,
      { id: string; name: string; cwd: string; key: string }
    >();
    const add = (project: { projectId: string; projectName: string; cwd: string }) => {
      const key = gatewayProjectKey(gatewayId, project.projectId);
      if (!values.has(key)) {
        values.set(key, {
          id: project.projectId,
          name: project.projectName,
          cwd: project.cwd,
          key,
        });
      }
    };
    add(workspace);
    for (const session of sessions) add(session);
    return [...values.values()];
  }, [gatewayId, sessions, workspace]);
  const currentProjectKey = gatewayProjectKey(
    gatewayId,
    workspace.projectId,
  );
  const [projectSelection, setProjectSelection] = useState(currentProjectKey);
  const [projectName, setProjectName] = useState(workspace.projectName);
  const [cwd, setCwd] = useState(workspace.cwd);
  const [model, setModel] = useState(workspace.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(
    workspace.reasoningEffort ??
      models.find((entry) => entry.id === workspace.model)
        ?.defaultReasoningLevel ??
      "",
  );
  const [enabledExtensions, setEnabledExtensions] = useState<Record<string, boolean>>({});
  const [extensionConfig, setExtensionConfig] = useState<
    Record<string, Record<string, JsonValue>>
  >(() =>
    Object.fromEntries(
      extensions.map((extension) => [
        extension.id,
        Object.fromEntries(
          extension.settings.flatMap((setting) =>
            setting.defaultValue === undefined
              ? []
              : [[setting.id, setting.defaultValue]],
          ),
        ),
      ]),
    ),
  );
  const dialogRef = useRef<HTMLElement>(null);
  const projectSelectRef = useRef<HTMLSelectElement>(null);

  const requestClose = () => {
    if (!busy) onClose();
  };
  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: projectSelectRef,
    escapeDisabled: busy,
    onEscape: requestClose,
  });

  const selectedModel = models.find((entry) => entry.id === model);
  const reasoningLevels = selectedModel?.supportedReasoningLevels ?? [];

  const extensionConfigValid = extensions.every((extension) => {
    if (!enabledExtensions[extension.id]) return true;
    return extension.settings.every((setting) => {
      const value = extensionConfig[extension.id]?.[setting.id];
      return setting.type !== "text" || !setting.required ||
        (typeof value === "string" && value.trim().length > 0);
    });
  });

  if (!open) return null;
  const chooseProject = (next: string) => {
    setProjectSelection(next);
    if (next === NEW_PROJECT) {
      setProjectName("");
      setCwd("");
      return;
    }
    const project = projects.find((entry) => entry.key === next);
    if (!project) return;
    setProjectName(project.name);
    setCwd(project.cwd);
  };

  const chooseModel = (next: string) => {
    setModel(next);
    const capability = models.find((entry) => entry.id === next);
    const supported = capability?.supportedReasoningLevels ?? [];
    if (!supported.some((level) => level.effort === reasoningEffort)) {
      setReasoningEffort(capability?.defaultReasoningLevel ?? supported[0]?.effort ?? "");
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = projectName.trim();
    const normalizedCwd = cwd.trim();
    if (!normalizedName || !normalizedCwd || busy) return;
    onCreate({
      cwd: normalizedCwd,
      projectName: normalizedName,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(extensions.some((extension) => enabledExtensions[extension.id])
        ? {
            extensions: extensions
              .filter((extension) => enabledExtensions[extension.id])
              .map((extension) => ({
                id: extension.id,
                config: extensionConfig[extension.id] ?? {},
              })),
          }
        : {}),
    });
  };

  return (
    <div
      className="new-session-backdrop"
      role="presentation"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Computer · Project</span>
            <h2 id="new-session-title">Create a session</h2>
            <p>{gatewayName}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close new session"
            disabled={busy}
          >
            ×
          </button>
        </header>

        <form onSubmit={submit}>
          <label>
            <span>Project</span>
            <select
              ref={projectSelectRef}
              value={projectSelection}
              onChange={(event) => chooseProject(event.target.value)}
              disabled={busy}
            >
              {projects.map((project) => (
                <option key={project.key} value={project.key}>
                  {project.name} — {project.cwd}
                </option>
              ))}
              <option value={NEW_PROJECT}>New project…</option>
            </select>
          </label>

          <div className="new-session-grid">
            <label>
              <span>Project name</span>
              <input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="My project"
                disabled={busy || projectSelection !== NEW_PROJECT}
                autoComplete="off"
              />
            </label>
            <label>
              <span>Working directory</span>
              <input
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="/Users/me/Documents/project"
                disabled={busy || projectSelection !== NEW_PROJECT}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <small className="project-identity-note">
            Project names may repeat. Codever distinguishes them by computer
            and working directory.
          </small>

          <div className="new-session-grid two-columns">
            <label>
              <span>Model</span>
              <select
                value={model}
                onChange={(event) => chooseModel(event.target.value)}
                disabled={busy || models.length === 0}
              >
                {!model && <option value="">Computer default</option>}
                {models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Reasoning effort</span>
              <select
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value)}
                disabled={busy || reasoningLevels.length === 0}
              >
                {reasoningLevels.length === 0 && (
                  <option value="">Model default</option>
                )}
                {reasoningLevels.map((level) => (
                  <option key={level.effort} value={level.effort}>
                    {level.effort}
                    {level.effort === selectedModel?.defaultReasoningLevel
                      ? " (default)"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {extensions.length > 0 && (
            <fieldset className="session-extensions">
              <legend>Optional session extensions</legend>
              <p className="session-extensions-note">
                Off by default. Enabled extensions are fixed for the lifetime of
                this session so they cannot be bypassed later.
              </p>
              {extensions.map((extension) => {
                const enabled = Boolean(enabledExtensions[extension.id]);
                return (
                  <section className="session-extension-option" key={extension.id}>
                    <label className="session-extension-toggle">
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={busy}
                        onChange={(event) =>
                          setEnabledExtensions((current) => ({
                            ...current,
                            [extension.id]: event.target.checked,
                          }))
                        }
                      />
                      <span>
                        <strong>{extension.name}</strong>
                        <small>{extension.description}</small>
                      </span>
                    </label>
                    {enabled && extension.settings.length > 0 && (
                      <div className="session-extension-settings">
                        {extension.settings.map((setting) =>
                          setting.type === "boolean" ? (
                            <label className="session-extension-boolean" key={setting.id}>
                              <input
                                type="checkbox"
                                checked={Boolean(
                                  extensionConfig[extension.id]?.[setting.id],
                                )}
                                disabled={busy}
                                onChange={(event) =>
                                  setExtensionConfig((current) => ({
                                    ...current,
                                    [extension.id]: {
                                      ...current[extension.id],
                                      [setting.id]: event.target.checked,
                                    },
                                  }))
                                }
                              />
                              <span>{setting.label}</span>
                            </label>
                          ) : (
                            <label key={setting.id}>
                              <span>{setting.label}</span>
                              <input
                                value={String(
                                  extensionConfig[extension.id]?.[setting.id] ?? "",
                                )}
                                placeholder={setting.placeholder}
                                disabled={busy}
                                required={setting.required}
                                autoComplete="off"
                                onChange={(event) =>
                                  setExtensionConfig((current) => ({
                                    ...current,
                                    [extension.id]: {
                                      ...current[extension.id],
                                      [setting.id]: event.target.value,
                                    },
                                  }))
                                }
                              />
                              {setting.description && <small>{setting.description}</small>}
                            </label>
                          ),
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </fieldset>
          )}

          <footer>
            <button
              type="button"
              className="secondary-button"
              onClick={requestClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={
                busy ||
                !projectName.trim() ||
                !cwd.trim() ||
                !extensionConfigValid
              }
            >
              {busy ? "Creating…" : "Create session"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export type { NewSessionInput };
