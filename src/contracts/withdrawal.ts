import type { RequestOptions, ZatoshiAmount } from "../types.js";
import type { TransactionAttemptError } from "./coordinator.js";

export interface WithdrawalInput {
  /** Stable exchange ledger ID for this immutable destination, amount, and memo. */
  readonly withdrawalId: string;
  readonly walletId: string;
  readonly toAddress: string;
  readonly amountZat: ZatoshiAmount;
  readonly memoHex?: string;
}

export type WithdrawalState =
  | "accepted"
  | "signing"
  | "ready_to_broadcast"
  | "broadcast"
  | "mined"
  | "confirmed"
  | "blocked"
  | "failed";

export interface WithdrawalStatus {
  readonly withdrawalId: string;
  readonly attemptId: string;
  readonly walletId: string;
  readonly state: WithdrawalState;
  readonly internalState: string;
  readonly error?: TransactionAttemptError;
  readonly txid?: string;
  readonly expiryHeight?: number;
  readonly updatedAt: string;
}

export interface ProcessWithdrawalOptions extends RequestOptions {
  readonly pollIntervalMs?: number;
  readonly waitTimeoutMs?: number;
  readonly onStatus?: (status: WithdrawalStatus) => void;
}

export interface NoteSplitInput {
  /** Stable exchange ID for this split; reuse it on every retry. */
  readonly splitId: string;
  readonly walletId: string;
  /** Number of equal notes to create, from 2 to 199. */
  readonly noteCount: number;
  readonly noteZat: ZatoshiAmount;
}

export interface NoteSplitStatus extends Omit<WithdrawalStatus, "withdrawalId"> {
  readonly splitId: string;
}
