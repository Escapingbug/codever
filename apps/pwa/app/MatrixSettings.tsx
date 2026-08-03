"use client";

import { useState } from "react";
import type {
  MatrixConnectionConfig,
  MatrixConnectionStatus,
} from "./matrix";
import { PairingWizard } from "./PairingWizard";
import type {
  GeneratedDeviceInvitation,
  PairingPreview,
  TrustedGateway,
} from "./pairing";
import { CODEVER_BUILD_VERSION } from "./buildInfo";
import type { PwaUpdateState } from "./pwaUpdate";

type Props = {
  open: boolean;
  config: MatrixConnectionConfig;
  status: MatrixConnectionStatus;
  progressDetail: string | null;
  error: string | null;
  pairingPreview: PairingPreview | null;
  trustedGateway: TrustedGateway | null;
  pairingBusy: boolean;
  deviceInvitation: GeneratedDeviceInvitation | null;
  invitationBusy: boolean;
  invitationError: string | null;
  invitationReauthRequired: boolean;
  updateState: PwaUpdateState;
  onChange(config: MatrixConnectionConfig): void;
  onPairingLink(link: string): void;
  onClearPairing(): void;
  onConfirmPairing(): void;
  onClose(): void;
  onConnect(): void;
  onDisconnect(): void;
  onForget(): void;
  onPasswordLogin(userId: string, password: string): void;
  onCreateInvitation(password?: string): void;
  onClearInvitation(): void;
  onCheckForUpdates(): void;
};

export function MatrixSettings({
  open,
  config,
  status,
  progressDetail,
  error,
  pairingPreview,
  trustedGateway,
  pairingBusy,
  deviceInvitation,
  invitationBusy,
  invitationError,
  invitationReauthRequired,
  updateState,
  onChange,
  onPairingLink,
  onClearPairing,
  onConfirmPairing,
  onClose,
  onConnect,
  onDisconnect,
  onForget,
  onPasswordLogin,
  onCreateInvitation,
  onClearInvitation,
  onCheckForUpdates,
}: Props) {
  const [loginPassword, setLoginPassword] = useState("");

  if (!open) return null;
  const connected =
    status === "connected" ||
    status === "securing" ||
    status === "reconnecting";
  const busy =
    status === "connecting" ||
    status === "securing" ||
    pairingBusy ||
    invitationBusy;
  const needsAccount = Boolean(pairingPreview) && !trustedGateway;

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={() => {
        setLoginPassword("");
        onClose();
      }}
    >
      <section
        className="matrix-settings pairing-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Secure devices</span>
            <h2 id="matrix-settings-title">
              {trustedGateway ? "Gateway connection" : "Add a Gateway"}
            </h2>
          </div>
          <button
            onClick={() => {
              setLoginPassword("");
              onClose();
            }}
            aria-label="Close Gateway settings"
          >
            ×
          </button>
        </header>

        <div className="settings-security-note">
          <span>✓</span>
          <p>
            Your Gateway provides one QR code or pairing link. The six-digit
            code confirms it directly; Matrix transports encrypted messages
            but never decides which device Codever trusts.
          </p>
        </div>

        <PairingWizard
          preview={pairingPreview}
          trustedGateway={trustedGateway}
          busy={busy}
          progressDetail={progressDetail}
          canConfirm={Boolean(config.accessToken)}
          deviceInvitation={deviceInvitation}
          invitationBusy={invitationBusy}
          invitationError={invitationError}
          invitationReauthRequired={invitationReauthRequired}
          onLink={onPairingLink}
          onClear={onClearPairing}
          onConfirm={onConfirmPairing}
          onCreateInvitation={onCreateInvitation}
          onClearInvitation={onClearInvitation}
        />

        {(needsAccount || trustedGateway) && (
          <details className="connection-details" open={needsAccount}>
            <summary>
              <span>
                <strong>Matrix connection</strong>
                <small>
                  {needsAccount
                    ? "Sign in once to complete encrypted pairing"
                    : status === "securing"
                      ? "Matrix connected; verifying the trusted Gateway"
                    : connected
                      ? "Connected and end-to-end encrypted"
                      : "Saved on this device"}
                </small>
              </span>
              <b>
                {status === "securing"
                  ? "Securing"
                  : connected
                    ? "Online"
                    : needsAccount
                      ? "Required"
                      : "Details"}
              </b>
            </summary>

            <div className="matrix-form-grid compact-matrix-form">
              <label className="wide-field">
                <span>Homeserver</span>
                <input
                  value={config.homeserver}
                  readOnly={Boolean(pairingPreview || trustedGateway)}
                  placeholder="Provided by the Gateway"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    onChange({ ...config, homeserver: event.target.value })
                  }
                />
              </label>
              {needsAccount && !config.accessToken && (
                <>
                  <label className="wide-field">
                    <span>Matrix ID</span>
                    <input
                      value={config.userId}
                      placeholder="@you:example.org"
                      autoComplete="username"
                      spellCheck={false}
                      onChange={(event) =>
                        onChange({ ...config, userId: event.target.value })
                      }
                    />
                  </label>
                  <label className="wide-field">
                    <span>Password</span>
                    <input
                      type="password"
                      value={loginPassword}
                      placeholder="Your Matrix password"
                      autoComplete="current-password"
                      onChange={(event) => setLoginPassword(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="matrix-password-login-button wide-field"
                    disabled={
                      busy || !config.userId.trim() || !loginPassword
                    }
                    onClick={() => {
                      onPasswordLogin(config.userId, loginPassword);
                      setLoginPassword("");
                    }}
                  >
                    {pairingBusy ? "Signing in…" : "Sign in to Matrix"}
                  </button>
                  <p className="matrix-session-hint wide-field">
                    This creates a separate Matrix device session. Codever
                    never asks you to copy an access token.
                  </p>
                </>
              )}
              {config.accessToken && (
                <p className="matrix-session-hint wide-field">
                  Signed in as {config.userId || "your Matrix account"} on this
                  device.
                </p>
              )}
              <details className="advanced-token-field wide-field">
                <summary>Advanced: use an access token</summary>
                <label>
                  <span>Access token</span>
                  <input
                    type="password"
                    value={config.accessToken}
                    placeholder="syt_••••••••••••"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      onChange({
                        ...config,
                        accessToken: event.target.value,
                      })
                    }
                  />
                </label>
              </details>
              <label>
                <span>Encrypted room</span>
                <input value={config.roomId} readOnly placeholder="From QR code" />
              </label>
            </div>
          </details>
        )}

        {error && (
          <div className="connection-error" role="alert">
            <strong>
              {pairingPreview && !trustedGateway
                ? "Pairing needs attention"
                : "Connection needs attention"}
            </strong>
            <span>{error}</span>
          </div>
        )}

        <div className="settings-build-version">
          <span>
            PWA build <code>{CODEVER_BUILD_VERSION}</code>
            <small>{updateStatusText(updateState)}</small>
          </span>
          <button
            type="button"
            onClick={onCheckForUpdates}
            disabled={
              updateState.phase === "checking" ||
              updateState.phase === "updating"
            }
          >
            {updateState.phase === "checking" ? "Checking…" : "Check for updates"}
          </button>
        </div>

        <footer>
          <button className="forget-button" onClick={onForget}>
            {trustedGateway ? "Remove trusted Gateway" : "Clear local setup"}
          </button>
          <span className="settings-spacer" />
          {connected && (
            <button className="disconnect-button" onClick={onDisconnect}>
              Disconnect
            </button>
          )}
          {trustedGateway && (
            <button
              className="connect-button"
              onClick={onConnect}
              disabled={busy}
            >
              {busy
                ? "Connecting…"
                : connected
                  ? "Reconnect"
                  : "Connect securely"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function updateStatusText(state: PwaUpdateState): string {
  switch (state.phase) {
    case "checking":
      return "Checking the deployed version…";
    case "updating":
      return `Updating to ${state.latestVersion}…`;
    case "updated":
      return `Updated from ${state.previousVersion}`;
    case "unavailable":
      return "Could not check right now";
    case "current":
      return state.checkedAt ? "Up to date" : "Automatic updates enabled";
  }
}
