"use client";

import { useEffect, useRef, useState } from "react";
import type { PairingPreview, TrustedGateway } from "./pairing";

type Props = {
  preview: PairingPreview | null;
  trustedGateway: TrustedGateway | null;
  busy: boolean;
  onLink(link: string): void;
  onClear(): void;
  onConfirm(): void;
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
  onLink,
  onClear,
  onConfirm,
}: Props) {
  const [link, setLink] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);

  if (trustedGateway && !preview) {
    return (
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
          disabled={busy}
        >
          {busy
            ? "Completing secure pairing…"
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
