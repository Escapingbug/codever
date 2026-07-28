"use client";

import { useState } from "react";
import type {
  MatrixConnectionConfig,
  MatrixConnectionStatus,
} from "./matrix";

type Props = {
  open: boolean;
  config: MatrixConnectionConfig;
  status: MatrixConnectionStatus;
  error: string | null;
  keyId: string | null;
  publicJwk: JsonWebKey | null;
  matrixDeviceKeys: string[];
  onChange(config: MatrixConnectionConfig): void;
  onClose(): void;
  onConnect(): void;
  onDisconnect(): void;
  onForget(): void;
};

const fields: Array<{
  key: keyof MatrixConnectionConfig;
  label: string;
  placeholder: string;
  type?: string;
}> = [
  {
    key: "homeserver",
    label: "Homeserver",
    placeholder: "https://matrix.example.org",
  },
  {
    key: "userId",
    label: "Matrix user",
    placeholder: "@you:example.org",
  },
  {
    key: "accessToken",
    label: "Access token",
    placeholder: "syt_••••••••••••",
    type: "password",
  },
  {
    key: "matrixDeviceId",
    label: "Device ID",
    placeholder: "CODEVER_WEB_01",
  },
  {
    key: "roomId",
    label: "Encrypted room",
    placeholder: "!room:example.org",
  },
  {
    key: "gatewayId",
    label: "Gateway ID",
    placeholder: "studio-mac",
  },
  {
    key: "conversationId",
    label: "Conversation ID",
    placeholder: "Defaults to the room ID",
  },
  {
    key: "gatewayMatrixUserId",
    label: "Gateway Matrix user",
    placeholder: "@gateway:example.org",
  },
  {
    key: "gatewayMatrixDeviceId",
    label: "Gateway Matrix device",
    placeholder: "CODEVER_GATEWAY_01",
  },
  {
    key: "gatewayMatrixEd25519",
    label: "Gateway Ed25519 fingerprint",
    placeholder: "Pinned fingerprint shown by the Gateway",
  },
];

export function MatrixSettings({
  open,
  config,
  status,
  error,
  keyId,
  publicJwk,
  matrixDeviceKeys,
  onChange,
  onClose,
  onConnect,
  onDisconnect,
  onForget,
}: Props) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  const connected = status === "connected" || status === "reconnecting";
  const busy = status === "connecting";

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="matrix-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Local connection</span>
            <h2 id="matrix-settings-title">Real Matrix</h2>
          </div>
          <button onClick={onClose} aria-label="Close Matrix settings">
            ×
          </button>
        </header>

        <div className="settings-security-note">
          <span>✓</span>
          <p>
            Credentials stay in this browser. Codever connects directly to your
            homeserver and never sends them to the hosted app. Room keys are
            shared only with verified Matrix devices. You can connect once
            without a Gateway pin to export the PWA pairing record; sending is
            enabled after all three Gateway identity fields are pinned.
          </p>
        </div>

        <div className="matrix-form-grid">
          {fields.map((field) => (
            <label
              key={field.key}
              className={
                field.key === "homeserver" || field.key === "accessToken"
                  ? "wide-field"
                  : ""
              }
            >
              <span>{field.label}</span>
              <input
                type={field.type ?? "text"}
                value={config[field.key]}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  onChange({ ...config, [field.key]: event.target.value })
                }
              />
            </label>
          ))}
        </div>

        <div className="identity-card">
          <span className="identity-mark">K</span>
          <div>
            <strong>Codever command identity</strong>
            <small>
              {keyId
                ? `P-256 · ${keyId.slice(0, 18)}…`
                : "Created on first connect and saved in IndexedDB"}
            </small>
          </div>
          {keyId && publicJwk && matrixDeviceKeys.length > 0 && (
            <button
              className="copy-pairing-button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(
                    JSON.stringify(
                      {
                        deviceId: config.matrixDeviceId,
                        publicKey: publicJwk,
                        allowedRoomIds: [config.roomId],
                        allowedOperations: [
                          "prompt",
                          "cancel",
                          "decision",
                          "session.settings",
                        ],
                        matrixUserId: config.userId,
                        matrixDeviceId: config.matrixDeviceId,
                        matrixDeviceKeys,
                      },
                      null,
                      2,
                    ),
                  )
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1800);
                  });
              }}
            >
              {copied ? "Copied" : "Copy pairing record"}
            </button>
          )}
        </div>

        {error && (
          <div className="connection-error" role="alert">
            <strong>Connection failed</strong>
            <span>{error}</span>
          </div>
        )}

        <footer>
          <button className="forget-button" onClick={onForget}>
            Clear local config
          </button>
          <span className="settings-spacer" />
          {connected && (
            <button className="disconnect-button" onClick={onDisconnect}>
              Disconnect
            </button>
          )}
          <button
            className="connect-button"
            onClick={onConnect}
            disabled={busy}
          >
            {busy ? "Connecting…" : connected ? "Reconnect" : "Connect securely"}
          </button>
        </footer>
      </section>
    </div>
  );
}
