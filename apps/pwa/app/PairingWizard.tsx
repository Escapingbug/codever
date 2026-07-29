"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type {
  GeneratedDeviceInvitation,
  PairingPreview,
  TrustedGateway,
} from "./pairing";

type Props = {
  preview: PairingPreview | null;
  trustedGateway: TrustedGateway | null;
  busy: boolean;
  canConfirm: boolean;
  deviceInvitation: GeneratedDeviceInvitation | null;
  invitationBusy: boolean;
  invitationReauthRequired: boolean;
  onLink(link: string): void;
  onClear(): void;
  onConfirm(): void;
  onCreateInvitation(password?: string): void;
  onClearInvitation(): void;
};

type BarcodeDetectorLike = {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
};

type BarcodeDetectorConstructor = new (options?: {
  formats?: string[];
}) => BarcodeDetectorLike;

export function PairingWizard({
  preview,
  trustedGateway,
  busy,
  canConfirm,
  deviceInvitation,
  invitationBusy,
  invitationReauthRequired,
  onLink,
  onClear,
  onConfirm,
  onCreateInvitation,
  onClearInvitation,
}: Props) {
  const [link, setLink] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [reauthPassword, setReauthPassword] = useState("");
  const [qrCode, setQrCode] = useState({ link: "", dataUrl: "" });
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!deviceInvitation) return;
    void QRCode.toDataURL(deviceInvitation.link, {
      errorCorrectionLevel: "L",
      margin: 2,
      width: 320,
    }).then((value) => {
      if (!cancelled) {
        setQrCode({ link: deviceInvitation.link, dataUrl: value });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [deviceInvitation]);
  const qrDataUrl =
    qrCode.link === deviceInvitation?.link ? qrCode.dataUrl : "";

  if (trustedGateway && !preview) {
    return (
      <div className="device-invitation-flow">
        <section className="paired-gateway-card" aria-label="Trusted Gateway">
          <span className="gateway-device-mark" aria-hidden="true">
            G
          </span>
          <div>
            <span className="paired-label">Trusted Gateway</span>
            <strong>{trustedGateway.gatewayName}</strong>
            <small>
              Paired {formatDate(trustedGateway.pairedAt)} · identity verified
            </small>
          </div>
          <span className="verified-badge">Verified</span>
        </section>

        {!deviceInvitation && !invitationReauthRequired && (
          <button
            className="create-device-invitation-button"
            type="button"
            disabled={invitationBusy}
            onClick={() => onCreateInvitation()}
          >
            {invitationBusy ? "Creating invitation…" : "Add another device"}
          </button>
        )}

        {invitationReauthRequired && !deviceInvitation && (
          <section className="invitation-reauth" aria-live="polite">
            <strong>Confirm it’s you</strong>
            <p>
              Matrix requires your password before issuing a one-time login
              token. The password is sent only to your homeserver.
            </p>
            <label>
              <span>Matrix password</span>
              <input
                type="password"
                value={reauthPassword}
                autoComplete="current-password"
                onChange={(event) => setReauthPassword(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={invitationBusy || !reauthPassword}
              onClick={() => onCreateInvitation(reauthPassword)}
            >
              {invitationBusy
                ? "Authorizing…"
                : "Create secure invitation"}
            </button>
          </section>
        )}

        {deviceInvitation && (
          <section className="generated-device-invitation" aria-live="polite">
            <div>
              <strong>Scan on the new device</strong>
              <p>
                This invitation works once and expires{" "}
                {formatExpiry(deviceInvitation.expiresAt)}.
                {deviceInvitation.includesMatrixLogin
                  ? " It signs the new device into Matrix without exposing your access token."
                  : " The new device will sign in to Matrix separately."}
              </p>
            </div>
            {qrDataUrl ? (
              // QR codes are local data URLs; an image optimizer cannot improve
              // them and could accidentally move the invitation off-device.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                width={320}
                height={320}
                alt="One-time Codever device invitation QR code"
              />
            ) : (
              <div className="invitation-qr-loading">Generating QR code…</div>
            )}
            <label>
              <span>One-time invitation link</span>
              <textarea
                value={deviceInvitation.link}
                readOnly
                rows={3}
                spellCheck={false}
              />
            </label>
            <div className="pairing-actions">
              <button
                type="button"
                className="scan-button"
                onClick={() => {
                  setShareStatus(null);
                  void navigator.clipboard
                    .writeText(deviceInvitation.link)
                    .then(() => setShareStatus("Invitation link copied."))
                    .catch(() =>
                      setShareStatus(
                        "Copy was blocked. Select the link above manually.",
                      ),
                    );
                }}
              >
                Copy link
              </button>
              {typeof navigator.share === "function" && (
                <button
                  type="button"
                  className="paste-button"
                  onClick={() =>
                    void navigator
                      .share({
                        title: `Join ${trustedGateway.gatewayName}`,
                        text: "Open this one-time Codever device invitation.",
                        url: deviceInvitation.link,
                      })
                      .catch(() => undefined)
                  }
                >
                  Share
                </button>
              )}
              <button
                type="button"
                className="continue-link-button"
                onClick={onClearInvitation}
              >
                Done
              </button>
            </div>
            {shareStatus && <small role="status">{shareStatus}</small>}
          </section>
        )}
      </div>
    );
  }

  if (preview) {
    return (
      <section className="pairing-confirmation" aria-live="polite">
        <div className="pairing-device">
          <span className="gateway-device-mark" aria-hidden="true">
            G
          </span>
          <div>
            <span className="paired-label">Gateway found</span>
            <strong>{preview.gatewayName}</strong>
            <small>{friendlyHomeserver(preview.transport.homeserver)}</small>
          </div>
          <button className="text-button" onClick={onClear} disabled={busy}>
            Change
          </button>
        </div>

        <div className="verification-panel">
          <span>Invitation code</span>
          <strong>{preview.verificationCode}</strong>
          <small>
            Expires {formatExpiry(preview.expiresAt)}. Use this code to identify
            the one-time request in Gateway logs; it is not a password.
          </small>
        </div>

        <button
          className="pair-confirm-button"
          onClick={onConfirm}
          disabled={busy || !canConfirm}
        >
          {busy
            ? "Completing secure pairing…"
            : !canConfirm
              ? "Sign in to Matrix to continue"
            : `Trust ${preview.gatewayName} and pair`}
        </button>
      </section>
    );
  }

  return (
    <section className="pairing-start">
      <div className="pairing-hero">
        <span className="pairing-lock" aria-hidden="true">
          ↗
        </span>
        <div>
          <h3>Add your Gateway</h3>
          <p>
            Open Codever Gateway on your computer and choose Add device. Then
            scan its QR code or paste the one-time pairing link shown there.
          </p>
        </div>
      </div>

      <label className="pairing-link-field">
        <span>One-time pairing link</span>
        <textarea
          value={link}
          placeholder="codever://pair?data=…"
          rows={3}
          spellCheck={false}
          onChange={(event) => setLink(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (pasted.trim()) {
              event.preventDefault();
              setLink(pasted);
              onLink(pasted);
            }
          }}
        />
      </label>

      <div className="pairing-actions">
        <button
          className="scan-button"
          onClick={() => setScannerOpen(true)}
          type="button"
        >
          <span aria-hidden="true">▦</span> Scan QR code
        </button>
        <button
          className="paste-button"
          onClick={() => {
            setClipboardError(null);
            void navigator.clipboard
              .readText()
              .then((value) => {
                setLink(value);
                onLink(value);
              })
              .catch(() => {
                setClipboardError(
                  "Clipboard access was blocked. Paste the link in the box above.",
                );
              });
          }}
          type="button"
        >
          Paste from clipboard
        </button>
        <button
          className="continue-link-button"
          onClick={() => onLink(link)}
          disabled={!link.trim()}
          type="button"
        >
          Continue
        </button>
      </div>
      {clipboardError && (
        <p className="pairing-inline-error" role="alert">
          {clipboardError}
        </p>
      )}

      {scannerOpen && (
        <QrScanner
          onResult={(value) => {
            setLink(value);
            setScannerOpen(false);
            onLink(value);
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </section>
  );
}

function QrScanner({
  onResult,
  onClose,
}: {
  onResult(value: string): void;
  onClose(): void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | null = null;

    void (async () => {
      const Detector = (
        window as typeof window & {
          BarcodeDetector?: BarcodeDetectorConstructor;
        }
      ).BarcodeDetector;
      if (!Detector) {
        setError(
          "QR scanning is not available in this browser. Paste the pairing link instead.",
        );
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (stopped || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const detector = new Detector({ formats: ["qr_code"] });
        const scan = async () => {
          if (stopped || !videoRef.current) return;
          const results = await detector.detect(videoRef.current);
          const value = results[0]?.rawValue;
          if (value) {
            onResult(value);
            return;
          }
          timer = window.setTimeout(() => void scan(), 220);
        };
        await scan();
      } catch (scanError) {
        setError(
          scanError instanceof Error
            ? scanError.message
            : "Camera access was not available.",
        );
      }
    })();

    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onResult]);

  return (
    <div className="scanner-backdrop" role="presentation">
      <section
        className="scanner-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Scan Gateway QR code"
      >
        <header>
          <strong>Scan Gateway QR code</strong>
          <button onClick={onClose} aria-label="Close QR scanner">
            ×
          </button>
        </header>
        {error ? (
          <div className="scanner-fallback">
            <span aria-hidden="true">▦</span>
            <p>{error}</p>
            <button onClick={onClose}>Paste a link instead</button>
          </div>
        ) : (
          <div className="scanner-viewport">
            <video ref={videoRef} playsInline muted />
            <span className="scanner-frame" aria-hidden="true" />
            <small>Center the Codever QR code in the frame</small>
          </div>
        )}
      </section>
    </div>
  );
}

function formatExpiry(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function friendlyHomeserver(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
