import { encodePathSegment } from "./validation.js";

export interface CoordinatorPaths {
  readonly attempts: string;
  readonly attempt: (attemptId: string) => string;
  readonly cancelAttempt: (attemptId: string) => string;
  /** Falls back to the standard coordinator route when omitted. */
  readonly activeAttempts?: (walletId: string) => string;
}

export interface GatewayPaths {
  readonly broadcast: string;
  readonly transaction: (txid: string) => string;
  /** Falls back to the standard gateway route when omitted. */
  readonly walletBalance?: (walletId: string) => string;
}

export const DEFAULT_COORDINATOR_PATHS: Readonly<Required<CoordinatorPaths>> = Object.freeze({
  attempts: "/v1/transaction-attempts",
  attempt: (attemptId: string) =>
    `/v1/transaction-attempts/${encodePathSegment(attemptId, "attemptId")}`,
  cancelAttempt: (attemptId: string) =>
    `/v1/transaction-attempts/${encodePathSegment(attemptId, "attemptId")}/cancel`,
  activeAttempts: (walletId: string) =>
    `/v1/wallets/${encodePathSegment(walletId, "walletId")}/transaction-attempts/active`,
});

export const DEFAULT_GATEWAY_PATHS: Readonly<Required<GatewayPaths>> = Object.freeze({
  broadcast: "/v1/transactions/broadcast",
  transaction: (txid: string) => `/v1/transactions/${encodePathSegment(txid, "txid")}`,
  walletBalance: (walletId: string) =>
    `/v1/wallets/${encodePathSegment(walletId, "walletId")}/notes/summary`,
});
