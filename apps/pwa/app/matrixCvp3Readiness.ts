import type { MatrixConnectionStatus } from "./matrix";

export type MatrixCvp3AuthorityPhase =
  | "transport-only"
  | "recovering"
  | "ready"
  | "failed";

export type MatrixCvp3StatusUpdate = {
  status: MatrixConnectionStatus;
  detail?: string;
};

/**
 * Keeps Matrix transport readiness separate from authoritative CVP/3 state.
 * A successful /sync cannot make a trusted client ready before snapshots and
 * the session directory converge, or hide a recovery failure afterwards.
 */
export class MatrixCvp3Readiness {
  #phase: MatrixCvp3AuthorityPhase;
  #failureDetail: string | null = null;

  constructor(hasTrustedGateway: boolean) {
    this.#phase = hasTrustedGateway ? "recovering" : "transport-only";
  }

  get phase(): MatrixCvp3AuthorityPhase {
    return this.#phase;
  }

  get canPublishAuthoritativeProjection(): boolean {
    return this.#phase === "ready";
  }

  beginRecovery(): void {
    this.#phase = "recovering";
    this.#failureDetail = null;
  }

  completeRecovery(): void {
    this.#phase = "ready";
    this.#failureDetail = null;
  }

  failRecovery(detail: string): void {
    this.#phase = "failed";
    this.#failureDetail = detail;
  }

  statusForMatrixSync(state: string): MatrixCvp3StatusUpdate | null {
    if (this.#phase === "failed") {
      return {
        status: "error",
        detail: this.#failureDetail ?? "Authoritative CVP/3 recovery failed.",
      };
    }
    if (state === "SYNCING" || state === "PREPARED") {
      return this.#phase === "recovering"
        ? { status: "connecting", detail: "matrix_gateway_state_syncing" }
        : { status: "connected" };
    }
    if (state === "RECONNECTING" || state === "CATCHUP" || state === "ERROR") {
      return {
        status: "reconnecting",
        detail: "Encrypted Matrix sync is recovering…",
      };
    }
    if (state === "STOPPED") return { status: "offline" };
    return null;
  }
}
