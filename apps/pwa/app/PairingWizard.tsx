"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode/lib/browser.js";
import type { CodeverPublicTrust } from "./client/CodeverClient";
import type {
  GeneratedDeviceInvitation,
  PairingPreview,
} from "./pairing";
import {
  createNativeQrDetector,
  detectQrFromCanvas,
  decodeQrImageFile,
  drawVideoFrame,
} from "./qrScanning";
import {
  NATIVE_BACK_PRIORITY,
  useNativeBackHandler,
} from "./nativeBackNavigation";
import { useDialogFocus } from "./dialogFocus";

type Props = {
  preview: PairingPreview | null;
  trustedGateway: CodeverPublicTrust | null;
  busy: boolean;
  progressDetail: string | null;
  canConfirm: boolean;
  deviceInvitation: GeneratedDeviceInvitation | null;
  invitationBusy: boolean;
  invitationError: string | null;
  invitationReauthRequired: boolean;
  onLink(link: string): void;
  onClear(): void;
  onConfirm(): void;
  onCreateInvitation(password?: string): void;
  onClearInvitation(): void;
};

export function PairingWizard({
  preview,
  trustedGateway,
  busy,
  progressDetail,
  canConfirm,
  deviceInvitation,
  invitationBusy,
  invitationError,
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
  const [imageScanBusy, setImageScanBusy] = useState(false);
  const [imageScanError, setImageScanError] = useState<string | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  useNativeBackHandler(
    scannerOpen,
    () => {
      setScannerOpen(false);
      return true;
    },
    NATIVE_BACK_PRIORITY.nestedModal,
  );

  useEffect(() => {
    let cancelled = false;
    if (!deviceInvitation) return;
    void QRCode.toDataURL(deviceInvitation.link, {
      errorCorrectionLevel: "L",
      margin: 4,
      width: 256,
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
          <>
            <button
              className="create-device-invitation-button"
              type="button"
              disabled={invitationBusy}
              onClick={() => onCreateInvitation()}
            >
              {invitationBusy ? "Creating invitation…" : "Add another device"}
            </button>
            {invitationError && (
              <p className="pairing-inline-error" role="status">
                {invitationError}
              </p>
            )}
          </>
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
            {invitationError && (
              <p className="pairing-inline-error" role="status">
                {invitationError}
              </p>
            )}
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
                width={256}
                height={256}
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
                rows={2}
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
        {busy && progressDetail && (
          <p className="pairing-scan-status" role="status">
            {progressDetail}
          </p>
        )}
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
          onTakePhoto={() => {
            setScannerOpen(false);
            cameraInputRef.current?.click();
          }}
          onChoosePhoto={() => {
            setScannerOpen(false);
            photoInputRef.current?.click();
          }}
        />
      )}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          void decodeSelectedQrImage(
            event.currentTarget,
            setImageScanBusy,
            setImageScanError,
            (value) => {
              setLink(value);
              onLink(value);
            },
          );
        }}
      />
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          void decodeSelectedQrImage(
            event.currentTarget,
            setImageScanBusy,
            setImageScanError,
            (value) => {
              setLink(value);
              onLink(value);
            },
          );
        }}
      />
      {imageScanBusy && (
        <p className="pairing-scan-status" role="status">
          Reading QR code from image…
        </p>
      )}
      {imageScanError && (
        <p className="pairing-inline-error" role="alert">
          {imageScanError}
        </p>
      )}
    </section>
  );
}

function QrScanner({
  onResult,
  onClose,
  onTakePhoto,
  onChoosePhoto,
}: {
  onResult(value: string): void;
  onClose(): void;
  onTakePhoto(): void;
  onChoosePhoto(): void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onResultRef = useRef(onResult);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);

  useDialogFocus({
    open: true,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
  });

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | null = null;

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(
          "Live camera access is not available in this browser. Take a photo or choose an image instead.",
        );
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        streamRef.current = stream;
        if (stopped || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const nativeDetector = createNativeQrDetector();
        const scan = async () => {
          if (
            stopped ||
            !stream?.active ||
            !videoRef.current ||
            !canvasRef.current
          ) {
            return;
          }
          if (drawVideoFrame(videoRef.current, canvasRef.current)) {
            const value = await detectQrFromCanvas(
              canvasRef.current,
              nativeDetector,
            );
            if (value) {
              stopCameraStream(streamRef, videoRef);
              onResultRef.current(value);
              return;
            }
          }
          timer = window.setTimeout(() => void scan(), 220);
        };
        await scan();
      } catch (scanError) {
        setError(cameraErrorMessage(scanError));
      }
    })();

    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      if (streamRef.current === stream) streamRef.current = null;
    };
  }, []);

  const leaveLiveCamera = (next: () => void) => {
    stopCameraStream(streamRef, videoRef);
    next();
  };

  return (
    <div className="scanner-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="scanner-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Scan Gateway QR code"
        tabIndex={-1}
      >
        <header>
          <strong>Scan Gateway QR code</strong>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close QR scanner"
          >
            ×
          </button>
        </header>
        {error ? (
          <div className="scanner-fallback">
            <span aria-hidden="true">▦</span>
            <p>{error}</p>
          </div>
        ) : (
          <div className="scanner-viewport">
            <video ref={videoRef} playsInline muted />
            <canvas ref={canvasRef} hidden aria-hidden="true" />
            <span className="scanner-frame" aria-hidden="true" />
            <small>Point the camera at a Codever QR code</small>
          </div>
        )}
        <div className="scanner-source-actions">
          <button type="button" onClick={() => leaveLiveCamera(onTakePhoto)}>
            Take photo
          </button>
          <button type="button" onClick={() => leaveLiveCamera(onChoosePhoto)}>
            Choose photo
          </button>
          <button type="button" onClick={onClose}>
            Paste link instead
          </button>
        </div>
        <p className="scanner-device-hint">
          QR on this phone? Choose its screenshot, or open the invitation link
          directly.
        </p>
      </section>
    </div>
  );
}

async function decodeSelectedQrImage(
  input: HTMLInputElement,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
  onResult: (value: string) => void,
): Promise<void> {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  setBusy(true);
  setError(null);
  try {
    const value = await decodeQrImageFile(file);
    if (!value) {
      throw new Error("No QR code was found in that image.");
    }
    onResult(value);
  } catch (error) {
    setError(
      error instanceof Error
        ? error.message
        : "The selected image could not be scanned.",
    );
  } finally {
    setBusy(false);
  }
}

function stopCameraStream(
  streamRef: { current: MediaStream | null },
  videoRef: { current: HTMLVideoElement | null },
): void {
  streamRef.current?.getTracks().forEach((track) => track.stop());
  streamRef.current = null;
  if (videoRef.current) videoRef.current.srcObject = null;
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Camera permission was denied. Take a photo or choose an image instead.";
    }
    if (error.name === "NotFoundError") {
      return "No camera was found. Choose an image containing the QR code.";
    }
    if (error.name === "NotReadableError") {
      return "The camera is busy in another app. Take a photo or choose an image instead.";
    }
  }
  return error instanceof Error
    ? error.message
    : "Camera access was not available.";
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
