import type { PollOptions, RequestOptions, ZatoshiAmount } from "../types.js";

export type KnownTransactionAttemptState =
  | "planning"
  | "reserved"
  | "awaiting_approval"
  | "awaiting_external_signature"
  | "signing"
  | "signed"
  | "broadcast"
  | "mempool"
  | "confirmed"
  | "cancelled"
  | "expired"
  | "failed"
  | "rejected"
  | "signing_unknown";

export type TransactionAttemptState = KnownTransactionAttemptState | (string & {});

export interface TransactionOutputInput {
  readonly toAddress: string;
  readonly amountZat: ZatoshiAmount;
  readonly memoHex?: string;
}

export interface CreateTransactionAttemptInput {
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly approvalReference: string;
  readonly outputs: readonly TransactionOutputInput[];
  readonly requestId?: string;
}

export interface CreateRawTransactionInput {
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly approvalReference: string;
  readonly toAddress: string;
  readonly amountZat: ZatoshiAmount;
  readonly memoHex?: string;
  readonly requestId?: string;
}

export interface TransactionAttempt {
  readonly attemptId: string;
  readonly walletId: string;
  readonly approvalReference: string;
  readonly state: TransactionAttemptState;
  readonly amountZat?: string;
  readonly feeZat?: string;
  readonly expiryHeight?: number;
  readonly planDigest?: string;
  readonly selectedNoteIds?: readonly string[];
  readonly txid?: string;
  readonly rawTxHex?: string;
  readonly orchardOutputActionIndices?: readonly number[];
  readonly orchardChangeActionIndex?: number | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface SignedTransaction {
  readonly attemptId: string;
  readonly walletId: string;
  readonly approvalReference: string;
  readonly state: "signed";
  readonly amountZat?: string;
  readonly feeZat: string;
  readonly expiryHeight: number;
  readonly planDigest: string;
  readonly selectedNoteIds: readonly string[];
  readonly txid: string;
  readonly rawTxHex: string;
  readonly orchardOutputActionIndices: readonly number[];
  readonly orchardChangeActionIndex: number | null;
}

export interface CreateAttemptOptions extends RequestOptions {}
export interface GetAttemptOptions extends RequestOptions {
  readonly requestId?: string;
}
export interface CancelAttemptOptions extends RequestOptions {
  readonly requestId?: string;
}
export interface CreateRawTransactionOptions extends PollOptions {}
