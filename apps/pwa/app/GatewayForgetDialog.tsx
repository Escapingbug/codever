"use client";

import { useRef } from "react";
import { useDialogFocus } from "./dialogFocus";
import {
  NATIVE_BACK_PRIORITY,
  useNativeBackHandler,
} from "./nativeBackNavigation";

type Props = {
  open: boolean;
  gatewayName: string | null;
  busy: boolean;
  onClose(): void;
  onConfirm(): void;
};

export function GatewayForgetDialog({
  open,
  gatewayName,
  busy,
  onClose,
  onConfirm,
}: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const requestClose = () => {
    if (!busy) onClose();
  };

  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: cancelRef,
    escapeDisabled: busy,
    onEscape: requestClose,
  });
  useNativeBackHandler(
    open,
    () => {
      requestClose();
      return true;
    },
    NATIVE_BACK_PRIORITY.nestedModal,
  );

  if (!open) return null;
  const trustedGateway = Boolean(gatewayName);

  return (
    <div
      className="new-session-backdrop"
      role="presentation"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className="session-delete-dialog gateway-forget-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="gateway-forget-title"
        aria-describedby="gateway-forget-description gateway-forget-boundary"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="danger-symbol" aria-hidden="true">
          !
        </div>
        <span className="eyebrow">This device</span>
        <h2 id="gateway-forget-title">
          {trustedGateway
            ? `Remove “${gatewayName}” from this device?`
            : "Clear this device’s local setup?"}
        </h2>
        <p id="gateway-forget-description">
          This disconnects Codever and removes the saved connection, approved
          computer, and locally cached conversation history from this device.
        </p>
        <div id="gateway-forget-boundary" className="delete-boundary-note">
          Your sessions and data on the computer or server are not deleted.
        </div>
        <footer>
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={requestClose}
          >
            {trustedGateway ? "Keep computer" : "Keep local setup"}
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy
              ? "Removing…"
              : trustedGateway
                ? "Remove computer"
                : "Clear local setup"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export type { Props as GatewayForgetDialogProps };
