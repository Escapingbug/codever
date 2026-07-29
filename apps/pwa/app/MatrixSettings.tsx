"use client";

import type {
  MatrixConnectionConfig,
  MatrixConnectionStatus,
} from "./matrix";
import { PairingWizard } from "./PairingWizard";
import type { PairingPreview, TrustedGateway } from "./pairing";

type Props = {
  open: boolean;
  config: MatrixConnectionConfig;
  status: MatrixConnectionStatus;
  error: string | null;
  pairingPreview: PairingPreview | null;
  trustedGateway: TrustedGateway | null;
  pairingBusy: boolean;
  onChange(config: MatrixConnectionConfig): void;
  onPairingLink(link: string): void;
  onClearPairing(): void;
  onConfirmPairing(): void;
  onClose(): void;
  onConnect(): void;
  onDisconnect(): void;
  onForget(): void;
};

const accountFields: Array<{
  key: "accessToken";
  label: string;
  placeholder: string;
  type?: string;
}> = [
  {
    key: "accessToken",
    label: "Access token",
    placeholder: "syt_••••••••••••",
    type: "password",
  },
];

export function MatrixSettings({
  open,
  config,
  status,
  error,
  pairingPreview,
  trustedGateway,
  pairingBusy,
  onChange,
  onPairingLink,
  onClearPairing,
  onConfirmPairing,
  onClose,
  onConnect,
  onDisconnect,
  onForget,
}: Props) {
  if (!open) return null;
  const connected = status === "connected" || status === "reconnecting";
  const busy = status === "connecting" || pairingBusy;
  const needsAccount = Boolean(pairingPreview) && !trustedGateway;

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
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
          <button onClick={onClose} aria-label="Close Gateway settings">
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
          onLink={onPairingLink}
          onClear={onClearPairing}
          onConfirm={onConfirmPairing}
        />

        {(needsAccount || trustedGateway) && (
          <details className="connection-details" open={needsAccount}>
            <summary>
              <span>
                <strong>Matrix connection</strong>
                <small>
                  {needsAccount
                    ? "Sign in once to complete encrypted pairing"
                    : connected
                      ? "Connected and end-to-end encrypted"
                      : "Saved on this device"}
                </small>
              </span>
              <b>{connected ? "Online" : needsAccount ? "Required" : "Details"}</b>
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
              {accountFields.map((field) => (
                <label
                  key={field.key}
                  className={
                    field.key === "accessToken" ? "wide-field" : undefined
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
                      onChange({
                        ...config,
                        [field.key]: event.target.value,
                      })
                    }
                  />
                </label>
              ))}
              {needsAccount && (
                <p className="matrix-session-hint wide-field">
                  Your Matrix account and this device are identified
                  automatically from the token.
                </p>
              )}
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
