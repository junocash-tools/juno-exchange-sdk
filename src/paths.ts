import { encodePathSegment } from "./validation.js";

export interface CoordinatorPaths {
  readonly attempts: string;
  readonly attempt: (attemptId: string) => string;
  readonly cancelAttempt: (attemptId: string) => string;
}

export interface GatewayPaths {
  readonly broadcast: string;
  readonly transaction: (txid: string) => string;
}

export const DEFAULT_COORDINATOR_PATHS: CoordinatorPaths = Object.freeze({
  attempts: "/v1/transaction-attempts",
  attempt: (attemptId: string) =>
    `/v1/transaction-attempts/${encodePathSegment(attemptId, "attemptId")}`,
  cancelAttempt: (attemptId: string) =>
    `/v1/transaction-attempts/${encodePathSegment(attemptId, "attemptId")}/cancel`,
});

export const DEFAULT_GATEWAY_PATHS: GatewayPaths = Object.freeze({
  broadcast: "/v1/transactions/broadcast",
  transaction: (txid: string) => `/v1/transactions/${encodePathSegment(txid, "txid")}`,
});
