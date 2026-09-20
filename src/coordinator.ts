import type {
  CancelAttemptOptions,
  ActiveTransactionAttempts,
  CreateAttemptOptions,
  CreateRawTransactionInput,
  CreateRawTransactionOptions,
  CreateTransactionAttemptInput,
  GetAttemptOptions,
  ListActiveAttemptsOptions,
  SignedTransaction,
  TransactionAttempt,
  TransactionOutputInput,
} from "./contracts/coordinator.js";
import { ExchangeSdkError } from "./errors.js";
import { abortableDelay, HttpClient } from "./http.js";
import {
  DEFAULT_COORDINATOR_PATHS,
  type CoordinatorPaths,
} from "./paths.js";
import type { ClientOptions } from "./types.js";
import {
  asRecord,
  invalidArgument,
  invalidResponse,
  normalizePositiveZatoshi,
  optionalNonNegativeInteger,
  optionalString,
  requireString,
  validateAddress,
  validateApprovalReference,
  validateAttemptId,
  validateIdempotencyKey,
  validateMemoHex,
  validateRawTxHex,
  validateRequestId,
  validateResponseAttemptId,
  validateResponseRawTxHex,
  validateResponseTxid,
  validateUnsignedDecimal,
  validateWalletId,
} from "./validation.js";
import { unwrapSuccessEnvelope } from "./wire.js";

export interface CoordinatorClientOptions extends ClientOptions {
  readonly paths?: CoordinatorPaths;
}

const signedMaterialStates = new Set([
  "signed",
  "broadcast",
  "mined",
  "orphaned",
  "final",
]);

const terminalFailureStates = new Set([
  "failed_unsigned",
  "cancelled",
  "expired_pending_reconciliation",
  "released",
]);

export class CoordinatorClient {
  readonly #http: HttpClient;
  readonly #paths: Readonly<Required<CoordinatorPaths>>;
  readonly #network: ClientOptions["network"];

  constructor(options: CoordinatorClientOptions) {
    this.#http = new HttpClient(options);
    this.#paths = Object.freeze({
      attempts: options.paths?.attempts ?? DEFAULT_COORDINATOR_PATHS.attempts,
      attempt: options.paths?.attempt ?? DEFAULT_COORDINATOR_PATHS.attempt,
      cancelAttempt: options.paths?.cancelAttempt ?? DEFAULT_COORDINATOR_PATHS.cancelAttempt,
      activeAttempts: options.paths?.activeAttempts ?? DEFAULT_COORDINATOR_PATHS.activeAttempts,
    });
    this.#network = options.network;
  }

  async createAttempt(
    input: CreateTransactionAttemptInput,
    options: CreateAttemptOptions = {},
  ): Promise<TransactionAttempt> {
    const normalized = normalizeCreateInput(input, this.#network);
    const payload = await this.#http.request({
      method: "POST",
      path: this.#paths.attempts,
      operation: "coordinator.create_attempt",
      body: {
        wallet_id: normalized.walletId,
        approval_reference: normalized.approvalReference,
        outputs: normalized.outputs.map((output) => ({
          to_address: output.toAddress,
          amount_zat: output.amountZat,
          ...(output.memoHex === undefined ? {} : { memo_hex: output.memoHex }),
        })),
      },
      idempotencyKey: normalized.idempotencyKey,
      ...(normalized.requestId === undefined ? {} : { requestId: normalized.requestId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      retryMode: "idempotent_mutation",
    });
    return parseAttempt(unwrapSuccessEnvelope(payload).data);
  }

  async getAttempt(
    attemptId: string,
    options: GetAttemptOptions = {},
  ): Promise<TransactionAttempt> {
    const normalizedId = validateAttemptId(attemptId);
    const requestId = validateRequestId(options.requestId);
    const payload = await this.#http.request({
      method: "GET",
      path: this.#paths.attempt(normalizedId),
      operation: "coordinator.get_attempt",
      ...(requestId === undefined ? {} : { requestId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      retryMode: "read",
    });
    return parseAttempt(unwrapSuccessEnvelope(payload).data);
  }

  async status(attemptId: string, options: GetAttemptOptions = {}): Promise<TransactionAttempt> {
    return this.getAttempt(attemptId, options);
  }

  async listActiveAttempts(
    walletId: string,
    options: ListActiveAttemptsOptions = {},
  ): Promise<ActiveTransactionAttempts> {
    const normalizedWalletId = validateWalletId(walletId);
    const requestId = validateRequestId(options.requestId);
    const payload = await this.#http.request({
      method: "GET",
      path: this.#paths.activeAttempts(normalizedWalletId),
      operation: "coordinator.list_active_attempts",
      ...(requestId === undefined ? {} : { requestId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      retryMode: "read",
    });
    const record = asRecord(unwrapSuccessEnvelope(payload).data, "active attempts");
    const responseWalletId = validateWalletId(requireString(record, "wallet_id"));
    if (responseWalletId !== normalizedWalletId) {
      throw invalidResponse("wallet_id does not match the requested wallet");
    }
    if (!Array.isArray(record.attempts) || record.attempts.length > 1_000) {
      throw invalidResponse("attempts must be an array with at most 1000 entries");
    }
    const attempts = record.attempts.map((value) => {
      const attempt = parseAttempt(value);
      if (attempt.walletId !== normalizedWalletId || attempt.rawTxHex !== undefined) {
        throw invalidResponse("active attempt does not match the diagnostic contract");
      }
      return attempt;
    });
    return { walletId: responseWalletId, attempts };
  }

  async cancelAttempt(
    attemptId: string,
    options: CancelAttemptOptions = {},
  ): Promise<TransactionAttempt> {
    const normalizedId = validateAttemptId(attemptId);
    const requestId = validateRequestId(options.requestId);
    const payload = await this.#http.request({
      method: "POST",
      path: this.#paths.cancelAttempt(normalizedId),
      operation: "coordinator.cancel_attempt",
      ...(requestId === undefined ? {} : { requestId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      retryMode: "none",
    });
    return parseAttempt(unwrapSuccessEnvelope(payload).data);
  }

  async createRawTransaction(
    input: CreateRawTransactionInput,
    options: CreateRawTransactionOptions = {},
  ): Promise<SignedTransaction> {
    const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
    const waitTimeoutMs = positiveInteger(options.waitTimeoutMs ?? 2 * 60_000, "waitTimeoutMs");
    const deadline = Date.now() + waitTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, waitTimeoutMs);
    let attempt: TransactionAttempt | undefined;
    try {
      attempt = await this.createAttempt(
      {
        idempotencyKey: input.idempotencyKey,
        walletId: input.walletId,
        approvalReference: input.approvalReference,
        outputs: [
          {
            toAddress: input.toAddress,
            amountZat: input.amountZat,
            ...(input.memoHex === undefined ? {} : { memoHex: input.memoHex }),
          },
        ],
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
      requestOptions(options, controller.signal, deadline),
    );

    for (;;) {
      options.onStatus?.(attempt);
      if (signedMaterialStates.has(attempt.state)) return toSignedTransaction(attempt);
      if (terminalFailureStates.has(attempt.state)) throw terminalAttemptError(attempt);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await abortableDelay(
        Math.min(pollIntervalMs, remainingMs),
        controller.signal,
        "coordinator.create_raw_transaction",
      );
      attempt = await this.getAttempt(attempt.attemptId, requestOptions(options, controller.signal, deadline));
    }
    } catch (error) {
      if (!timedOut || options.signal?.aborted || !(error instanceof ExchangeSdkError) ||
          (error.code !== "client_aborted" && error.code !== "client_timeout")) throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    throw waitTimeoutError(attempt);
  }
}

interface NormalizedOutput {
  readonly toAddress: string;
  readonly amountZat: string;
  readonly memoHex?: string;
}

interface NormalizedCreateInput {
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly approvalReference: string;
  readonly outputs: readonly NormalizedOutput[];
  readonly requestId?: string;
}

function normalizeCreateInput(
  input: CreateTransactionAttemptInput,
  network: ClientOptions["network"],
): NormalizedCreateInput {
  if (!Array.isArray(input.outputs) || input.outputs.length < 1 || input.outputs.length > 199) {
    throw invalidArgument("outputs must contain between 1 and 199 entries");
  }
  const requestId = validateRequestId(input.requestId);
  const outputs = input.outputs.map((output, index) => normalizeOutput(output, index, network));
  const totalAmount = outputs.reduce((total, output) => total + BigInt(output.amountZat), 0n);
  if (totalAmount > 18_446_744_073_709_551_615n) {
    throw invalidArgument("the sum of output amounts exceeds the uint64 range");
  }
  return {
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
    walletId: validateWalletId(input.walletId),
    approvalReference: validateApprovalReference(input.approvalReference),
    outputs,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function normalizeOutput(
  output: TransactionOutputInput,
  index: number,
  network: ClientOptions["network"],
): NormalizedOutput {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw invalidArgument(`outputs[${index}] must be an object`);
  }
  const memoHex = validateMemoHex(output.memoHex);
  return {
    toAddress: validateAddress(output.toAddress, `outputs[${index}].toAddress`, network),
    amountZat: normalizePositiveZatoshi(output.amountZat, `outputs[${index}].amountZat`),
    ...(memoHex === undefined ? {} : { memoHex }),
  };
}

function parseAttempt(value: unknown): TransactionAttempt {
  const record = asRecord(value, "attempt");
  const state = requireString(record, "state");
  const attemptId = validateResponseAttemptId(requireString(record, "attempt_id"));
  const walletId = requireString(record, "wallet_id");
  validateWalletId(walletId);
  const approvalReference = validateApprovalReference(requireString(record, "approval_reference"));
  const changeAddress = optionalString(record, "change_address");
  const feeZat = optionalUnsignedDecimal(record, "fee_zat");
  const expiryHeight = optionalNonNegativeInteger(record, "expiry_height");
  if (expiryHeight === 0) throw invalidResponse("expiry_height must be a positive safe integer when present");
  const planDigest = optionalDigest(record, "plan_digest");
  const selectedNoteIds = optionalNoteIds(record, "selected_note_ids");
  const txidValue = record.txid;
  const txid = txidValue === undefined || txidValue === null ? undefined : validateResponseTxid(txidValue);
  const rawTxValue = record.raw_tx_hex;
  const rawTxHex =
    rawTxValue === undefined || rawTxValue === null ? undefined : validateResponseRawTxHex(rawTxValue);
  const outputIndices = optionalIndices(record, "orchard_output_action_indices");
  const changeIndex = optionalNullableIndex(record, "orchard_change_action_index");
  const attemptError = optionalAttemptError(record.error);
  const createdAt = requireTimestamp(record, "created_at");
  const updatedAt = requireTimestamp(record, "updated_at");

  return {
    attemptId,
    walletId,
    approvalReference,
    state,
    ...(changeAddress === undefined ? {} : { changeAddress }),
    ...(feeZat === undefined ? {} : { feeZat }),
    ...(expiryHeight === undefined ? {} : { expiryHeight }),
    ...(planDigest === undefined ? {} : { planDigest }),
    ...(selectedNoteIds === undefined ? {} : { selectedNoteIds }),
    ...(txid === undefined ? {} : { txid }),
    ...(rawTxHex === undefined ? {} : { rawTxHex }),
    ...(outputIndices === undefined ? {} : { orchardOutputActionIndices: outputIndices }),
    ...(changeIndex === undefined ? {} : { orchardChangeActionIndex: changeIndex }),
    ...(attemptError === undefined ? {} : { error: attemptError }),
    createdAt,
    updatedAt,
  };
}

function toSignedTransaction(attempt: TransactionAttempt): SignedTransaction {
  if (
    !signedMaterialStates.has(attempt.state) ||
    attempt.changeAddress === undefined ||
    attempt.feeZat === undefined ||
    attempt.expiryHeight === undefined ||
    attempt.planDigest === undefined ||
    attempt.selectedNoteIds === undefined ||
    attempt.txid === undefined ||
    attempt.rawTxHex === undefined ||
    attempt.orchardOutputActionIndices === undefined ||
    attempt.orchardOutputActionIndices.length !== 1
  ) {
    throw invalidResponse("signed attempt is missing required signed transaction fields");
  }
  if (
    attempt.orchardChangeActionIndex !== undefined &&
    attempt.orchardChangeActionIndex !== null &&
    attempt.orchardOutputActionIndices.includes(attempt.orchardChangeActionIndex)
  ) {
    throw invalidResponse("signed attempt maps change to a recipient output action");
  }
  validateRawTxHex(attempt.rawTxHex);
  return {
    attemptId: attempt.attemptId,
    walletId: attempt.walletId,
    approvalReference: attempt.approvalReference,
    state: attempt.state as SignedTransaction["state"],
    changeAddress: attempt.changeAddress,
    feeZat: attempt.feeZat,
    expiryHeight: attempt.expiryHeight,
    planDigest: attempt.planDigest,
    selectedNoteIds: attempt.selectedNoteIds,
    txid: attempt.txid,
    rawTxHex: attempt.rawTxHex,
    orchardOutputActionIndices: attempt.orchardOutputActionIndices,
    orchardChangeActionIndex: attempt.orchardChangeActionIndex ?? null,
  };
}

function optionalAttemptError(value: unknown): TransactionAttempt["error"] {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, "attempt error");
  const code = requireString(record, "code");
  const message = requireString(record, "message");
  const retryableValue = record.retryable;
  if (typeof retryableValue !== "boolean") {
    throw invalidResponse("attempt error retryable must be a boolean");
  }
  const detailsValue = record.details;
  let details: Readonly<Record<string, unknown>> | undefined;
  if (detailsValue !== undefined && detailsValue !== null) {
    details = Object.freeze({ ...asRecord(detailsValue, "attempt error details") });
  }
  return Object.freeze({
    code,
    message,
    retryable: retryableValue,
    ...(details === undefined ? {} : { details }),
  });
}

function optionalUnsignedDecimal(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return value === undefined || value === null ? undefined : validateUnsignedDecimal(value, key);
}

function optionalDigest(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
	throw invalidResponse(`${key} must use sha256 followed by a 64-character lowercase hexadecimal digest`);
  }
  return value;
}

function optionalNoteIds(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw invalidResponse(`${key} must contain between 1 and 200 note IDs`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !/^[0-9a-f]{64}:(0|[1-9][0-9]*)$/.test(entry) ||
      Number(entry.slice(entry.indexOf(":") + 1)) > 0xffff_ffff ||
      seen.has(entry)
    ) {
      throw invalidResponse(`${key} contains an invalid or duplicate note ID`);
    }
    seen.add(entry);
    return entry;
  });
}

function optionalIndices(
  record: Record<string, unknown>,
  key: string,
): readonly number[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 199) {
    throw invalidResponse(`${key} must be an array with at most 199 entries`);
  }
  const seen = new Set<number>();
  return value.map((entry) => {
    if (
      typeof entry !== "number" ||
      !Number.isInteger(entry) ||
      entry < 0 ||
      entry > 199 ||
      seen.has(entry)
    ) {
      throw invalidResponse(`${key} contains an invalid action index`);
    }
    seen.add(entry);
    return entry;
  });
}

function requireTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw invalidResponse(`${key} must be an RFC 3339 timestamp`);
  }
  return value;
}

function optionalNullableIndex(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 199) {
    throw invalidResponse(`${key} must be null or an action index from 0 to 199`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidArgument(`${field} must be positive`);
  return value;
}

function requestOptions(options: CreateRawTransactionOptions, signal: AbortSignal, deadline: number): GetAttemptOptions {
  return {
    signal,
    timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 30_000, deadline - Date.now())),
  };
}

function terminalAttemptError(attempt: TransactionAttempt): ExchangeSdkError {
  return new ExchangeSdkError(
    attempt.error?.message ?? `Transaction attempt entered terminal state ${attempt.state}`,
    {
      code: `transaction_attempt_${attempt.state}`,
      retryable: attempt.error?.retryable ?? false,
      details: {
        attempt_id: attempt.attemptId,
        state: attempt.state,
        ...(attempt.error === undefined ? {} : { attempt_error: attempt.error }),
      },
      operation: "coordinator.create_raw_transaction",
    },
  );
}

function waitTimeoutError(attempt: TransactionAttempt | undefined): ExchangeSdkError {
  return new ExchangeSdkError("Timed out waiting for a signed transaction; the attempt remains active", {
    code: "attempt_wait_timeout",
    retryable: true,
    details: attempt === undefined ? { action: "replay_original_creation_key" } : {
      attempt_id: attempt.attemptId, state: attempt.state,
      ...(attempt.error === undefined ? {} : { attempt_error: attempt.error }),
    },
    operation: "coordinator.create_raw_transaction",
  });
}
