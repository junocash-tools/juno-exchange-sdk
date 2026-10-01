import type {
  CancelAttemptOptions,
  ActiveTransactionAttempts,
  CreateAttemptOptions,
  CreateNoteSplitInput,
  CreateRawTransactionInput,
  CreateRawTransactionOptions,
  CreateTransactionAttemptInput,
  GetAttemptOptions,
  GetNoteInventoryOptions,
  ListActiveAttemptsOptions,
  NoteInventory,
  NoteReservation,
  NoteValueSummary,
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
  requireBoolean,
  requireNonNegativeInteger,
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
  validateResponseZatoshi,
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
const maxTimerMs = 2_147_483_647;

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
      noteInventory: options.paths?.noteInventory ?? DEFAULT_COORDINATOR_PATHS.noteInventory,
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

  /**
   * Fan wallet funds out into `noteCount` equal notes owned by the same wallet.
   * The result is an ordinary attempt: wait for `signed`, then broadcast the
   * raw transaction through the gateway like a withdrawal.
   */
  async createNoteSplit(
    input: CreateNoteSplitInput,
    options: CreateAttemptOptions = {},
  ): Promise<TransactionAttempt> {
    const noteCount = input.noteCount;
    if (!Number.isSafeInteger(noteCount) || noteCount < 2 || noteCount > 199) {
      throw invalidArgument("noteCount must be an integer from 2 to 199");
    }
    const noteZat = normalizePositiveZatoshi(input.noteZat, "noteZat");
    if (BigInt(noteZat) * BigInt(noteCount) > 18_446_744_073_709_551_615n) {
      throw invalidArgument("noteCount * noteZat exceeds the uint64 range");
    }
    const requestId = validateRequestId(input.requestId);
    const payload = await this.#http.request({
      method: "POST",
      path: this.#paths.attempts,
      operation: "coordinator.create_note_split",
      body: {
        wallet_id: validateWalletId(input.walletId),
        approval_reference: validateApprovalReference(input.approvalReference),
        split: { note_count: noteCount, note_zat: noteZat },
      },
      idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
      ...(requestId === undefined ? {} : { requestId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      retryMode: "idempotent_mutation",
    });
    return parseAttempt(unwrapSuccessEnvelope(payload).data);
  }

  /**
   * Spendable, reserved and unreserved note counts for a wallet, plus every
   * active reservation across all coordinator credentials.
   */
  async getNoteInventory(
    walletId: string,
    options: GetNoteInventoryOptions = {},
  ): Promise<NoteInventory> {
    const normalizedWalletId = validateWalletId(walletId);
    const requestId = validateRequestId(options.requestId);
    const payload = await this.#http.request({
      method: "GET",
      path: this.#paths.noteInventory(normalizedWalletId),
      operation: "coordinator.get_note_inventory",
      ...(requestId === undefined ? {} : { requestId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      retryMode: "read",
    });
    const inventory = parseNoteInventory(unwrapSuccessEnvelope(payload).data);
    if (inventory.walletId !== normalizedWalletId) {
      throw invalidResponse("wallet_id does not match the requested wallet");
    }
    return inventory;
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
    const pollIntervalMs = boundedTimer(positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs"), "pollIntervalMs");
    const waitTimeoutMs = boundedTimer(positiveInteger(options.waitTimeoutMs ?? 2 * 60_000, "waitTimeoutMs"), "waitTimeoutMs");
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

function parseNoteInventory(value: unknown): NoteInventory {
  const record = asRecord(value, "note inventory");
  const reservationsValue = record.reservations;
  if (!Array.isArray(reservationsValue) || reservationsValue.length > 5_000) {
    throw invalidResponse("reservations must be an array with at most 5000 entries");
  }
  const reservations = reservationsValue.map(parseNoteReservation);
  return {
    walletId: validateWalletId(requireString(record, "wallet_id")),
    minConfirmations: requireNonNegativeInteger(record, "min_confirmations"),
    minNoteZat: validateResponseZatoshi(record.min_note_zat, "min_note_zat"),
    asOfScannerHeight: requireNonNegativeInteger(record, "as_of_scanner_height"),
    spendable: parseNoteValueSummary(record.spendable, "spendable"),
    reservedSpendable: parseNoteValueSummary(record.reserved_spendable, "reserved_spendable"),
    unreservedSpendable: parseNoteValueSummary(record.unreserved_spendable, "unreserved_spendable"),
    targetNotes: requireNonNegativeInteger(record, "target_notes"),
    lowNoteInventory: requireBoolean(record, "low_note_inventory"),
    changeSplitMax: requireNonNegativeInteger(record, "change_split_max"),
    reservations,
    reservationsComplete: requireBoolean(record, "reservations_complete"),
  };
}

function parseNoteValueSummary(value: unknown, field: string): NoteValueSummary {
  const record = asRecord(value, field);
  return {
    noteCount: requireNonNegativeInteger(record, "note_count"),
    valueZat: validateResponseZatoshi(record.value_zat, `${field}.value_zat`),
  };
}

const noteStates = new Set(["unknown", "unspent", "pending", "spent"]);

function parseNoteReservation(value: unknown): NoteReservation {
  const record = asRecord(value, "note reservation");
  const noteIds = optionalNoteIds({ note_id: [requireString(record, "note_id")] }, "note_id");
  const noteState = requireString(record, "note_state");
  if (!noteStates.has(noteState)) throw invalidResponse("note_state is not a known note state");
  const expiryHeight = optionalNonNegativeInteger(record, "expiry_height");
  const valueZat = record.value_zat === undefined || record.value_zat === null
    ? undefined
    : validateResponseZatoshi(record.value_zat, "value_zat");
  return {
    noteId: noteIds![0]!,
    attemptId: validateResponseAttemptId(requireString(record, "attempt_id")),
    attemptState: requireString(record, "attempt_state"),
    ...(expiryHeight === undefined || expiryHeight === 0 ? {} : { expiryHeight }),
    noteState: noteState as NoteReservation["noteState"],
    ...(valueZat === undefined ? {} : { valueZat }),
    reservedAt: requireTimestamp(record, "reserved_at"),
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

function boundedTimer(value: number, field: string): number {
  if (value > maxTimerMs) throw invalidArgument(`${field} must not exceed ${maxTimerMs} milliseconds`);
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
