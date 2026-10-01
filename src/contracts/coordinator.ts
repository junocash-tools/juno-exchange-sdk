import type { PollOptions, RequestOptions, ZatoshiAmount } from "../types.js";

export type KnownTransactionAttemptState =
  | "planning"
  | "reserved"
  | "signing"
  | "signing_unknown"
  | "signed"
  | "broadcast"
  | "mined"
  | "expired_pending_reconciliation"
  | "orphaned"
  | "final"
  | "released"
  | "cancelled"
  | "failed_unsigned";

export type TransactionAttemptState = KnownTransactionAttemptState | (string & {});

export interface TransactionAttemptError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

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

export interface CreateNoteSplitInput {
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly approvalReference: string;
  /** Number of equal notes to create, from 2 to 199. */
  readonly noteCount: number;
  /** Value of each new note. */
  readonly noteZat: ZatoshiAmount;
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
  readonly changeAddress?: string;
  readonly feeZat?: string;
  readonly expiryHeight?: number;
  readonly planDigest?: string;
  readonly selectedNoteIds?: readonly string[];
  readonly txid?: string;
  readonly rawTxHex?: string;
  readonly orchardOutputActionIndices?: readonly number[];
  readonly orchardChangeActionIndex?: number | null;
  readonly error?: TransactionAttemptError;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SignedTransaction {
  readonly attemptId: string;
  readonly walletId: string;
  readonly approvalReference: string;
  readonly state: "signed" | "broadcast" | "mined" | "orphaned" | "final";
  readonly changeAddress: string;
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

export interface ListActiveAttemptsOptions extends RequestOptions {
  readonly requestId?: string;
}

export interface ActiveTransactionAttempts {
  readonly walletId: string;
  readonly attempts: readonly TransactionAttempt[];
}
export interface GetNoteInventoryOptions extends RequestOptions {
  readonly requestId?: string;
}

export interface NoteValueSummary {
  readonly noteCount: number;
  readonly valueZat: string;
}

export interface NoteReservation {
  readonly noteId: string;
  readonly attemptId: string;
  readonly attemptState: TransactionAttemptState;
  readonly expiryHeight?: number;
  readonly noteState: "unknown" | "unspent" | "pending" | "spent";
  readonly valueZat?: string;
  readonly reservedAt: string;
}

export interface NoteInventory {
  readonly walletId: string;
  readonly minConfirmations: number;
  readonly minNoteZat: string;
  readonly asOfScannerHeight: number;
  readonly spendable: NoteValueSummary;
  readonly reservedSpendable: NoteValueSummary;
  readonly unreservedSpendable: NoteValueSummary;
  readonly targetNotes: number;
  readonly lowNoteInventory: boolean;
  readonly changeSplitMax: number;
  /** Active reservations across every coordinator credential. */
  readonly reservations: readonly NoteReservation[];
  readonly reservationsComplete: boolean;
}

export interface CancelAttemptOptions extends RequestOptions {
  readonly requestId?: string;
}
export interface CreateRawTransactionOptions extends PollOptions {
  readonly onStatus?: (attempt: TransactionAttempt) => void;
}
