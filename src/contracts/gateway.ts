import type { RequestOptions } from "../types.js";

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

export interface BroadcastOptions extends RequestOptions {}
