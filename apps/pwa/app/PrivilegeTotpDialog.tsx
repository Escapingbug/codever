"use client";

import { FormEvent, useRef, useState } from "react";
import { useDialogFocus } from "./dialogFocus";
import {
  NATIVE_BACK_PRIORITY,
  useNativeBackHandler,
} from "./nativeBackNavigation";

type Props = {
  open: boolean;
  busy: boolean;
  error: string | null;
  gatewayName: string;
  onClose(): void;
  onSubmit(setupKey: string): void;
};

export function PrivilegeTotpDialog({
  open,
  busy,
  error,
  gatewayName,
  onClose,
  onSubmit,
}: Props) {
  const [setupKey, setSetupKey] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestClose = () => {
    if (!busy) onClose();
  };

  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy && setupKey.trim()) onSubmit(setupKey);
  }

  return (
    <div
      className="new-session-backdrop"
      role="presentation"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className="privilege-totp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="privilege-totp-title"
        aria-describedby="privilege-totp-description"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="privilege-totp-symbol" aria-hidden="true">⌁</div>
        <span className="eyebrow">One-time setup</span>
        <h2 id="privilege-totp-title">Protect administrator approval</h2>
        <p id="privilege-totp-description">
          Enter the TOTP setup key printed when the root Helper was installed
          on “{gatewayName}”. Codever will encrypt it with a fingerprint,
          face, or device-unlock protected credential.
        </p>
        <form onSubmit={submit}>
          <label>
            <span>TOTP setup key</span>
            <input
              ref={inputRef}
              value={setupKey}
              onChange={(event) => setSetupKey(event.target.value)}
              placeholder="JBSW Y3DP …"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy}
            />
          </label>
          <div className="privilege-totp-note">
            The plaintext setup key is not sent to the Gateway and is not
            stored in browser storage.
          </div>
          {error && <div className="privilege-totp-error" role="alert">{error}</div>}
          <footer>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={requestClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="approve-button"
              disabled={busy || !setupKey.trim()}
            >
              {busy ? "Waiting for device unlock…" : "Protect and approve"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export type { Props as PrivilegeTotpDialogProps };
