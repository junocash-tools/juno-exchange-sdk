import type {
  BroadcastOptions,
  BroadcastTransactionInput,
  BroadcastTransactionResult,
  GatewayTransaction,
  LookupTransactionOptions,
  TransactionLookupResult,
} from "./contracts/gateway.js";
import { HttpClient } from "./http.js";
import { DEFAULT_GATEWAY_PATHS, type GatewayPaths } from "./paths.js";
import type { ClientOptions } from "./types.js";
import {
  asRecord,
  invalidArgument,
  invalidResponse,
  optionalNonNegativeInteger,
  optionalString,
  requireBoolean,
  requireNonNegativeInteger,
  requireString,
  validateRawTxHex,
  validateRequestId,
  validateResponseRawTxHex,
  validateResponseTxid,
  validateTxid,
  validateWalletId,
} from "./validation.js";
import { unwrapSuccessEnvelope } from "./wire.js";

export interface GatewayClientOptions extends ClientOptions {
  readonly paths?: GatewayPaths;
}

export class GatewayClient {
  readonly #http: HttpClient;
  readonly #paths: GatewayPaths;

  constructor(options: GatewayClientOptions) {
    this.#http = new HttpClient(options);
    this.#paths = options.paths ?? DEFAULT_GATEWAY_PATHS;
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
