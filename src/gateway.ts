import type {
  BroadcastOptions,
  BroadcastTransactionInput,
  BroadcastTransactionResult,
  GatewayTransaction,
  GetWalletBalanceOptions,
  LookupTransactionOptions,
  PendingSpendWalletBalanceBucket,
  SpendableWalletBalanceBucket,
  TransactionLookupResult,
  WalletBalanceBucket,
  WalletBalanceResult,
} from "./contracts/gateway.js";
import { HttpClient } from "./http.js";
import { DEFAULT_GATEWAY_PATHS, type GatewayPaths } from "./paths.js";
import type { ClientOptions } from "./types.js";
import {
  asRecord,
  invalidArgument,
  invalidResponse,
  normalizeNonNegativeSignedZatoshi,
  optionalNonNegativeInteger,
  optionalString,
  requireBoolean,
  requireNonNegativeInteger,
  requireString,
  validateRawTxHex,
  validateRequestId,
  validateResponseRawTxHex,
  validateResponseTxid,
  validateResponseZatoshi,
  validateTxid,
  validateWalletId,
} from "./validation.js";
import { unwrapSuccessEnvelope } from "./wire.js";

export interface GatewayClientOptions extends ClientOptions {
  readonly paths?: GatewayPaths;
}

export class GatewayClient {
  readonly #http: HttpClient;
  readonly #paths: Readonly<Required<GatewayPaths>>;

  constructor(options: GatewayClientOptions) {
    this.#http = new HttpClient(options);
    this.#paths = Object.freeze({
      broadcast: options.paths?.broadcast ?? DEFAULT_GATEWAY_PATHS.broadcast,
      transaction: options.paths?.transaction ?? DEFAULT_GATEWAY_PATHS.transaction,
      walletBalance: options.paths?.walletBalance ?? DEFAULT_GATEWAY_PATHS.walletBalance,
    });
  }

  async broadcast(
    input: BroadcastTransactionInput,
    options: BroadcastOptions = {},
  ): Promise<BroadcastTransactionResult> {
    const walletId = validateWalletId(input.walletId);
    const rawTxHex = validateRawTxHex(input.rawTxHex);
    const expectedTxid = validateTxid(input.expectedTxid, "expectedTxid");
    const requestId = validateRequestId(input.requestId);
    const payload = await this.#http.request({
      method: "POST",
      path: this.#paths.broadcast,
      operation: "gateway.broadcast",
      body: {
        wallet_id: walletId,
        raw_tx_hex: rawTxHex,
        expected_txid: expectedTxid,
      },
      idempotencyKey: input.idempotencyKey,
      ...(requestId === undefined ? {} : { requestId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      retryMode: "broadcast",
    });
    return parseBroadcastResult(unwrapSuccessEnvelope(payload).data);
  }

  async lookupTransaction(
    txid: string,
    options: LookupTransactionOptions = {},
  ): Promise<TransactionLookupResult> {
    const normalizedTxid = validateTxid(txid);
    const walletId = options.walletId === undefined ? undefined : validateWalletId(options.walletId);
    const requestId = validateRequestId(options.requestId);
    if (options.includeRaw !== undefined && typeof options.includeRaw !== "boolean") {
      throw invalidArgument("includeRaw must be a boolean");
    }
    const query = new URLSearchParams();
    if (walletId !== undefined) query.set("wallet_id", walletId);
    if (options.includeRaw !== undefined) query.set("include_raw", String(options.includeRaw));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const payload = await this.#http.request({
      method: "GET",
      path: `${this.#paths.transaction(normalizedTxid)}${suffix}`,
      operation: "gateway.lookup_transaction",
      ...(requestId === undefined ? {} : { requestId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      retryMode: "read",
    });
    return parseLookupResult(unwrapSuccessEnvelope(payload).data);
  }

  async getWalletBalance(
    walletId: string,
    options: GetWalletBalanceOptions = {},
  ): Promise<WalletBalanceResult> {
    const normalizedWalletId = validateWalletId(walletId);
    const minConfirmations = optionalNonNegativeSafeIntegerArgument(
      options.minConfirmations,
      "minConfirmations",
    );
    const minNoteZat =
      options.minNoteZat === undefined
        ? undefined
        : normalizeNonNegativeSignedZatoshi(options.minNoteZat, "minNoteZat");
    const requestId = validateRequestId(options.requestId);
    const query = new URLSearchParams();
    if (minConfirmations !== undefined) {
      query.set("min_confirmations", String(minConfirmations));
    }
    if (minNoteZat !== undefined) query.set("min_note_zat", minNoteZat);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const payload = await this.#http.request({
      method: "GET",
      path: `${this.#paths.walletBalance(normalizedWalletId)}${suffix}`,
      operation: "gateway.get_wallet_balance",
      ...(requestId === undefined ? {} : { requestId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      retryMode: "read",
      losslessIntegerKeys: [
        "min_note_zat",
        "value_zat",
        "smallest_note_zat",
        "largest_note_zat",
      ],
    });
    return parseWalletBalance(
      unwrapSuccessEnvelope(payload).data,
      normalizedWalletId,
      minConfirmations,
      minNoteZat,
    );
  }
}

function parseBroadcastResult(value: unknown): BroadcastTransactionResult {
  const record = asRecord(value, "broadcast result");
  const walletId = requireString(record, "wallet_id");
  validateWalletId(walletId);
  return {
    walletId,
    txid: validateResponseTxid(record.txid),
    state: requireString(record, "state"),
    accepted: requireBoolean(record, "accepted"),
    alreadyKnown: requireBoolean(record, "already_known"),
  };
}

function parseLookupResult(value: unknown): TransactionLookupResult {
  const record = asRecord(value, "transaction lookup result");
  const transaction = parseTransaction(record.transaction);
  const walletIdValue = record.wallet_id;
  let walletId: string | undefined;
  if (walletIdValue !== undefined && walletIdValue !== null) {
    if (typeof walletIdValue !== "string") throw invalidResponse("wallet_id must be a string");
    walletId = validateWalletId(walletIdValue);
  }
  const effectsValue = record.wallet_effects;
  let walletEffects: readonly Readonly<Record<string, unknown>>[] | undefined;
  if (effectsValue !== undefined && effectsValue !== null) {
    if (!Array.isArray(effectsValue)) throw invalidResponse("wallet_effects must be an array");
    walletEffects = effectsValue.map((effect, index) =>
      Object.freeze({ ...asRecord(effect, `wallet_effects[${index}]`) }),
    );
  }
  return {
    transaction,
    ...(walletId === undefined ? {} : { walletId }),
    ...(walletEffects === undefined ? {} : { walletEffects }),
  };
}

function parseTransaction(value: unknown): GatewayTransaction {
  const record = asRecord(value, "transaction");
  const blockHash = optionalString(record, "block_hash");
  if (blockHash !== undefined) validateResponseTxid(blockHash, "block_hash");
  const rawTxValue = record.raw_tx_hex;
  const rawTxHex =
    rawTxValue === undefined || rawTxValue === null ? undefined : validateResponseRawTxHex(rawTxValue);
  return {
    txid: validateResponseTxid(record.txid),
    state: requireString(record, "state"),
    confirmations: requireNonNegativeInteger(record, "confirmations"),
    ...(blockHash === undefined ? {} : { blockHash }),
    ...optionalNumberProperty(record, "block_height", "blockHeight"),
    ...optionalNumberProperty(record, "block_time", "blockTime"),
    ...optionalNumberProperty(record, "expiry_height", "expiryHeight"),
    ...optionalNumberProperty(record, "serialized_size", "serializedSize"),
    ...optionalNumberProperty(record, "orchard_action_count", "orchardActionCount"),
    ...(rawTxHex === undefined ? {} : { rawTxHex }),
  };
}

function optionalNumberProperty<K extends string>(
  record: Record<string, unknown>,
  wireKey: string,
  outputKey: K,
): Partial<Record<K, number>> {
  const value = optionalNonNegativeInteger(record, wireKey);
  return value === undefined ? {} : ({ [outputKey]: value } as Record<K, number>);
}

function parseWalletBalance(
  value: unknown,
  expectedWalletId: string,
  expectedMinConfirmations: number | undefined,
  expectedMinNoteZat: string | undefined,
): WalletBalanceResult {
  const record = asRecord(value, "wallet balance");
  const walletId = requireString(record, "wallet_id");
  if (walletId !== expectedWalletId) {
    throw invalidResponse("wallet_id does not match the requested wallet");
  }
  const minConfirmations = requireNonNegativeInteger(record, "min_confirmations");
  if (expectedMinConfirmations !== undefined && minConfirmations !== expectedMinConfirmations) {
    throw invalidResponse("min_confirmations does not match the requested value");
  }
  const minNoteZat = requireZatoshi(record, "min_note_zat");
  if (expectedMinNoteZat !== undefined && minNoteZat !== expectedMinNoteZat) {
    throw invalidResponse("min_note_zat does not match the requested value");
  }
  const asOfNodeHeight = requireNonNegativeInteger(record, "as_of_node_height");
  const asOfScannerHeight = requireNonNegativeInteger(record, "as_of_scanner_height");
  const asOfScannerHash = validateResponseTxid(
    record.as_of_scanner_hash,
    "as_of_scanner_hash",
  );
  const scannerLag = requireNonNegativeInteger(record, "scanner_lag");
  if (
    asOfScannerHeight > asOfNodeHeight ||
    scannerLag !== asOfNodeHeight - asOfScannerHeight
  ) {
    throw invalidResponse("scanner height and lag are inconsistent with the node snapshot");
  }
  const totalUnspent = parseBalanceBucket(record.total_unspent, "total_unspent");
  const spendable = parseSpendableBalanceBucket(record.spendable, minNoteZat);
  const immature = parseBalanceBucket(record.immature, "immature");
  const pendingSpend = parsePendingSpendBalanceBucket(
    record.pending_spend,
    asOfScannerHeight,
  );
  const belowMinNote = parseBalanceBucket(record.below_min_note, "below_min_note");
  const witnessUnavailable = parseBalanceBucket(
    record.witness_unavailable,
    "witness_unavailable",
  );
  const partition = [spendable, immature, pendingSpend, belowMinNote, witnessUnavailable];
  const partitionCount = partition.reduce((total, bucket) => total + BigInt(bucket.noteCount), 0n);
  const partitionValue = partition.reduce((total, bucket) => total + BigInt(bucket.valueZat), 0n);
  if (
    partitionCount !== BigInt(totalUnspent.noteCount) ||
    partitionValue !== BigInt(totalUnspent.valueZat)
  ) {
    throw invalidResponse("wallet balance buckets do not partition total_unspent");
  }
  validateBelowMinNoteBucket(belowMinNote, minNoteZat);

  return {
    walletId,
    minConfirmations,
    minNoteZat,
    asOfNodeHeight,
    asOfScannerHeight,
    asOfScannerHash,
    scannerLag,
    totalUnspent,
    spendable,
    immature,
    pendingSpend,
    belowMinNote,
    witnessUnavailable,
  };
}

function parseBalanceBucket(value: unknown, field: string): WalletBalanceBucket {
  const record = asRecord(value, field);
  const noteCount = requireNonNegativeInteger(record, "note_count");
  const valueZat = requireZatoshi(record, "value_zat");
  if (noteCount === 0 && valueZat !== "0") {
    throw invalidResponse(`${field}.value_zat must be zero when note_count is zero`);
  }
  return { noteCount, valueZat };
}

function parseSpendableBalanceBucket(
  value: unknown,
  minNoteZat: string,
): SpendableWalletBalanceBucket {
  const record = asRecord(value, "spendable");
  const bucket = parseBalanceBucket(record, "spendable");
  const smallestNoteZat = optionalStrictZatoshi(record, "smallest_note_zat");
  const largestNoteZat = optionalStrictZatoshi(record, "largest_note_zat");
  if (bucket.noteCount === 0) {
    if (smallestNoteZat !== undefined || largestNoteZat !== undefined) {
      throw invalidResponse("spendable note extrema must be omitted when note_count is zero");
    }
    return bucket;
  }
  if (smallestNoteZat === undefined || largestNoteZat === undefined) {
    throw invalidResponse("spendable note extrema are required when note_count is positive");
  }
  const count = BigInt(bucket.noteCount);
  const valueZat = BigInt(bucket.valueZat);
  const smallest = BigInt(smallestNoteZat);
  const largest = BigInt(largestNoteZat);
  if (
    smallest === 0n ||
    smallest < BigInt(minNoteZat) ||
    smallest > largest ||
    largest > valueZat ||
    smallest * count > valueZat ||
    largest * count < valueZat
  ) {
    throw invalidResponse("spendable note extrema are inconsistent with its count and value");
  }
  return { ...bucket, smallestNoteZat, largestNoteZat };
}

function parsePendingSpendBalanceBucket(
  value: unknown,
  asOfScannerHeight: number,
): PendingSpendWalletBalanceBucket {
  const record = asRecord(value, "pending_spend");
  const bucket = parseBalanceBucket(record, "pending_spend");
  const knownExpiryCount = requireNonNegativeInteger(record, "known_expiry_count");
  const nextExpiryHeight = optionalStrictNonNegativeInteger(record, "next_expiry_height");
  const lastExpiryHeight = optionalStrictNonNegativeInteger(record, "last_expiry_height");
  if (knownExpiryCount > bucket.noteCount) {
    throw invalidResponse("known_expiry_count must not exceed pending_spend.note_count");
  }
  if (knownExpiryCount === 0) {
    if (nextExpiryHeight !== undefined || lastExpiryHeight !== undefined) {
      throw invalidResponse("pending spend expiry heights must be omitted when none are known");
    }
    return { ...bucket, knownExpiryCount };
  }
  if (nextExpiryHeight === undefined || lastExpiryHeight === undefined) {
    throw invalidResponse("pending spend expiry heights are required when an expiry is known");
  }
  if (nextExpiryHeight < asOfScannerHeight || nextExpiryHeight > lastExpiryHeight) {
    throw invalidResponse("pending spend expiry heights are inconsistent with the scanner snapshot");
  }
  return { ...bucket, knownExpiryCount, nextExpiryHeight, lastExpiryHeight };
}

function validateBelowMinNoteBucket(bucket: WalletBalanceBucket, minNoteZat: string): void {
  if (bucket.noteCount === 0) return;
  const minimum = BigInt(minNoteZat);
  if (minimum === 0n) {
    if (bucket.valueZat !== "0") {
      throw invalidResponse("below_min_note.value_zat must be zero when min_note_zat is zero");
    }
    return;
  }
  const maximumValue = BigInt(bucket.noteCount) * (minimum - 1n);
  if (BigInt(bucket.valueZat) > maximumValue) {
    throw invalidResponse("below_min_note.value_zat is inconsistent with min_note_zat");
  }
}

function requireZatoshi(record: Record<string, unknown>, key: string): string {
  return validateResponseZatoshi(record[key], key);
}

function optionalStrictZatoshi(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!(key in record)) return undefined;
  return requireZatoshi(record, key);
}

function optionalStrictNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  if (!(key in record)) return undefined;
  return requireNonNegativeInteger(record, key);
}

function optionalNonNegativeSafeIntegerArgument(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw invalidArgument(`${field} must be an integer between 0 and 10000`);
  }
  return value;
}
