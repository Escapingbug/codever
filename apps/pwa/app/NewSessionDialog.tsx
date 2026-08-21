"use client";

import { FormEvent, useRef, useState } from "react";
import type {
  JsonValue,
  SessionExtensionBinding,
  SessionExtensionDescriptor,
} from "@codever/protocol";
import { useDialogFocus } from "./dialogFocus";
import {
  type GatewayModelCapability,
  type GatewayWorkspaceState,
} from "./gatewayState";

type NewSessionInput = {
  scope?: "project" | "scratch";
  cwd: string;
  projectName: string;
  model?: string;
  reasoningEffort?: string;
  extensions?: SessionExtensionBinding[];
  setAsProjectDefault?: boolean;
};

type Props = {
  open: boolean;
  busy: boolean;
  gatewayName: string;
  workspace: GatewayWorkspaceState;
  models: GatewayModelCapability[];
  extensions: SessionExtensionDescriptor[];
  defaultExtensions?: SessionExtensionBinding[];
  canUpdateProjectDefaults?: boolean;
  onClose(): void;
  onCreate(input: NewSessionInput): void;
};

export function NewSessionDialog(props: Props) {
  if (!props.open) return null;
  return <NewSessionDialogContent {...props} />;
}

function NewSessionDialogContent({
  open,
  busy,
  gatewayName,
  workspace,
  models,
  extensions,
  defaultExtensions = [],
  canUpdateProjectDefaults = false,
  onClose,
  onCreate,
}: Props) {
  const [model, setModel] = useState(workspace.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(
    workspace.reasoningEffort ??
      models.find((entry) => entry.id === workspace.model)
        ?.defaultReasoningLevel ??
      "",
  );
  const [enabledExtensions, setEnabledExtensions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(defaultExtensions.map(binding => [binding.id, true])),
  );
  const [setAsProjectDefault, setSetAsProjectDefault] = useState(false);
  const [scope, setScope] = useState<"project" | "scratch">("project");
  const [extensionConfig, setExtensionConfig] = useState<
    Record<string, Record<string, JsonValue>>
  >(() =>
    Object.fromEntries(
      extensions.map((extension) => {
        const inherited = defaultExtensions.find(binding => binding.id === extension.id);
        return [
          extension.id,
          {
            ...Object.fromEntries(
              extension.settings.flatMap((setting) =>
                setting.defaultValue === undefined
                  ? []
                  : [[setting.id, setting.defaultValue]],
              ),
            ),
            ...(inherited?.config ?? {}),
          },
        ];
      }),
    ),
  );
  const dialogRef = useRef<HTMLElement>(null);
  const modelSelectRef = useRef<HTMLSelectElement>(null);

  const requestClose = () => {
    if (!busy) onClose();
  };
  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: modelSelectRef,
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
    if (busy) return;
    onCreate({
      scope,
      cwd: workspace.cwd,
      projectName: workspace.projectName,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      extensions: extensions
        .filter((extension) => enabledExtensions[extension.id])
        .map((extension) => ({
          id: extension.id,
          config: extensionConfig[extension.id] ?? {},
        })),
      ...(scope === "project" && setAsProjectDefault
        ? { setAsProjectDefault: true }
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
            <span className="eyebrow">
              {scope === "scratch" ? "Computer · Temporary" : "Computer · Project"}
            </span>
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
          <label className="scratch-session-toggle">
            <input
              type="checkbox"
              checked={scope === "scratch"}
              disabled={busy}
              onChange={(event) => {
                setScope(event.target.checked ? "scratch" : "project");
                if (event.target.checked) setSetAsProjectDefault(false);
              }}
            />
            <span>
              <strong>Temporary conversation</strong>
              <small>Use an isolated folder and keep this session outside project groups.</small>
            </span>
          </label>

          {scope === "project" ? <>
          <div className="new-session-grid">
            <label>
              <span>Project</span>
              <input value={workspace.projectName} disabled readOnly />
            </label>
            <label>
              <span>Working directory</span>
              <input value={workspace.cwd} disabled readOnly />
            </label>
          </div>
          <small className="project-identity-note">
            This Matrix room is the durable home for this project. Switch
            project rooms before creating a session for another directory.
          </small>
          </> : (
            <small className="project-identity-note scratch-identity-note">
              The Gateway creates a private working folder for this conversation.
              Deleting the conversation also removes that folder.
            </small>
          )}

          <div className="new-session-grid two-columns">
            <label>
              <span>Model</span>
              <select
                ref={modelSelectRef}
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
              <legend>Session extensions</legend>
              <p className="session-extensions-note">
                Project defaults are preselected. This session receives its own
                snapshot, so later project changes do not alter it.
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
              {canUpdateProjectDefaults && scope === "project" && (
                <label className="session-extension-boolean">
                  <input
                    type="checkbox"
                    checked={setAsProjectDefault}
                    disabled={busy}
                    onChange={(event) => setSetAsProjectDefault(event.target.checked)}
                  />
                  <span>Use this selection as the project default for future sessions</span>
                </label>
              )}
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
