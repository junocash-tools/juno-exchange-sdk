import type { RequestOptions, ZatoshiAmount } from "../types.js";

export interface BroadcastTransactionInput {
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly rawTxHex: string;
  readonly expectedTxid: string;
  readonly requestId?: string;
}

export interface BroadcastTransactionResult {
  readonly walletId: string;
  readonly txid: string;
  readonly state: string;
  readonly accepted: boolean;
  readonly alreadyKnown: boolean;
}

export interface LookupTransactionOptions extends RequestOptions {
  readonly walletId?: string;
  readonly includeRaw?: boolean;
  readonly requestId?: string;
}

export interface GatewayTransaction {
  readonly txid: string;
  readonly state: string;
  readonly confirmations: number;
  readonly blockHash?: string;
  readonly blockHeight?: number;
  readonly blockTime?: number;
  readonly expiryHeight?: number;
  readonly serializedSize?: number;
  readonly orchardActionCount?: number;
  readonly rawTxHex?: string;
}

export interface TransactionLookupResult {
  readonly transaction: GatewayTransaction;
  readonly walletId?: string;
  readonly walletEffects?: readonly Readonly<Record<string, unknown>>[];
}

export interface GetWalletBalanceOptions extends RequestOptions {
  readonly minConfirmations?: number;
  readonly minNoteZat?: ZatoshiAmount;
  readonly requestId?: string;
}

export interface WalletBalanceBucket {
  readonly noteCount: number;
  /** Canonical decimal zatoshi value. */
  readonly valueZat: string;
}

export interface SpendableWalletBalanceBucket extends WalletBalanceBucket {
  /** Present only when noteCount is greater than zero. */
  readonly smallestNoteZat?: string;
  /** Present only when noteCount is greater than zero. */
  readonly largestNoteZat?: string;
}

export interface PendingSpendWalletBalanceBucket extends WalletBalanceBucket {
  readonly knownExpiryCount: number;
  /** Present only when knownExpiryCount is greater than zero. */
  readonly nextExpiryHeight?: number;
  /** Present only when knownExpiryCount is greater than zero. */
  readonly lastExpiryHeight?: number;
}

export interface WalletBalanceResult {
  readonly walletId: string;
  readonly minConfirmations: number;
  /** Canonical decimal zatoshi value. */
  readonly minNoteZat: string;
  readonly asOfNodeHeight: number;
  readonly asOfScannerHeight: number;
  readonly asOfScannerHash: string;
  readonly scannerLag: number;
  readonly totalUnspent: WalletBalanceBucket;
  readonly spendable: SpendableWalletBalanceBucket;
  readonly immature: WalletBalanceBucket;
  readonly pendingSpend: PendingSpendWalletBalanceBucket;
  readonly belowMinNote: WalletBalanceBucket;
  readonly witnessUnavailable: WalletBalanceBucket;
}

export interface BroadcastOptions extends RequestOptions {}
