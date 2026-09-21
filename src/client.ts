import { CoordinatorClient } from "./coordinator.js";
import type { TransactionAttempt } from "./contracts/coordinator.js";
import type {
  ProcessWithdrawalOptions,
  WithdrawalInput,
  WithdrawalState,
  WithdrawalStatus,
} from "./contracts/withdrawal.js";
import { ExchangeSdkError, isExchangeSdkError } from "./errors.js";
import { GatewayClient } from "./gateway.js";
import { abortableDelay } from "./http.js";
import type { ExchangeClientOptions, RequestOptions } from "./types.js";
import { validateWalletId } from "./validation.js";

const withdrawalIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const maxTimerMs = 2_147_483_647;

function withdrawalKeys(withdrawalId: string): { approvalReference: string; createKey: string; broadcastKey: string } {
  if (typeof withdrawalId !== "string" || !withdrawalIdPattern.test(withdrawalId)) {
    throw new ExchangeSdkError("withdrawalId must be 1 to 96 safe characters", {
      code: "invalid_argument", retryable: false,
    });
  }
  return {
    approvalReference: `withdrawal:${withdrawalId}`,
    createKey: `withdrawal:${withdrawalId}:create`,
    broadcastKey: `withdrawal:${withdrawalId}:broadcast`,
  };
}

function publicStatus(attempt: TransactionAttempt, withdrawalId: string, expectedWalletId?: string): WithdrawalStatus {
  if (attempt.approvalReference !== withdrawalKeys(withdrawalId).approvalReference) {
    throw new ExchangeSdkError("attempt approval reference does not match withdrawalId", {
      code: "invalid_response", retryable: false,
    });
  }
  if (expectedWalletId !== undefined && attempt.walletId !== expectedWalletId) {
    throw new ExchangeSdkError("attempt wallet does not match withdrawal input", {
      code: "invalid_response", retryable: false,
    });
  }
  const states: Record<string, WithdrawalState> = {
    planning: "accepted", reserved: "signing", signing: "signing", signing_unknown: "blocked",
    signed: "ready_to_broadcast", broadcast: "broadcast", mined: "mined", final: "confirmed",
    orphaned: "blocked", expired_pending_reconciliation: "blocked",
    released: "failed", failed_unsigned: "failed", cancelled: "failed",
  };
  const state = states[attempt.state];
  if (state === undefined) {
    throw new ExchangeSdkError(`unknown coordinator attempt state ${attempt.state}`, {
      code: "invalid_response", retryable: false,
    });
  }
  return {
    withdrawalId, attemptId: attempt.attemptId, walletId: attempt.walletId,
    state, internalState: attempt.state,
    ...(attempt.error === undefined ? {} : { error: attempt.error }),
    ...(attempt.txid === undefined ? {} : { txid: attempt.txid }),
    ...(attempt.expiryHeight === undefined ? {} : { expiryHeight: attempt.expiryHeight }),
    updatedAt: attempt.updatedAt,
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExchangeSdkError(`${field} must be a positive safe integer`, {
      code: "invalid_argument", retryable: false,
    });
  }
  return value;
}

function boundedTimer(value: number, field: string): number {
  if (value > maxTimerMs) {
    throw new ExchangeSdkError(`${field} must not exceed ${maxTimerMs} milliseconds`, {
      code: "invalid_argument", retryable: false,
    });
  }
  return value;
}

export class JunoExchangeClient {
  readonly coordinator: CoordinatorClient;
  readonly gateway: GatewayClient;

  constructor(options: ExchangeClientOptions) {
    this.coordinator = new CoordinatorClient(options.coordinator);
    this.gateway = new GatewayClient(options.gateway);
  }

  /** Accept/replay immediately. Persist the attempt ID and run advanceWithdrawal in a durable worker. */
  async submitWithdrawal(input: WithdrawalInput, options: RequestOptions = {}): Promise<WithdrawalStatus> {
    const keys = withdrawalKeys(input.withdrawalId);
    const walletId = validateWalletId(input.walletId);
    const attempt = await this.coordinator.createAttempt({
      idempotencyKey: keys.createKey,
      walletId,
      approvalReference: keys.approvalReference,
      outputs: [{ toAddress: input.toAddress, amountZat: input.amountZat,
        ...(input.memoHex === undefined ? {} : { memoHex: input.memoHex }) }],
    }, options);
    return publicStatus(attempt, input.withdrawalId, walletId);
  }

  /** Inspect an existing attempt without creating or broadcasting a transaction. */
  async getWithdrawal(withdrawalId: string, attemptId: string, options: RequestOptions = {}): Promise<WithdrawalStatus> {
    withdrawalKeys(withdrawalId);
    return publicStatus(await this.coordinator.getAttempt(attemptId, options), withdrawalId);
  }

  /** One idempotent progression step. Do not replace this with a fresh ID after uncertainty. */
  async advanceWithdrawal(input: WithdrawalInput, options: RequestOptions = {}): Promise<WithdrawalStatus> {
    const walletId = validateWalletId(input.walletId);
    const normalizedInput = input.walletId === walletId ? input : { ...input, walletId };
    const status = await this.submitWithdrawal(normalizedInput, options);
    if (status.state !== "ready_to_broadcast") return status;
    // Re-read signed material through the expiry-checked coordinator route.
    const signed = await this.coordinator.getAttempt(status.attemptId, options);
    const current = publicStatus(signed, normalizedInput.withdrawalId, walletId);
    if (current.state !== "ready_to_broadcast") return current;
    const outputIndices = signed.orchardOutputActionIndices;
    const changeIndex = signed.orchardChangeActionIndex;
    if (!signed.rawTxHex || !signed.txid || signed.walletId !== walletId ||
        outputIndices?.length !== 1 || (changeIndex !== undefined && changeIndex !== null && changeIndex === outputIndices[0])) {
      throw new ExchangeSdkError("signed attempt is missing broadcast or output-mapping data", {
        code: "invalid_response", retryable: false,
        details: { attempt_id: status.attemptId },
      });
    }
    const broadcast = await this.gateway.broadcast({
      idempotencyKey: withdrawalKeys(normalizedInput.withdrawalId).broadcastKey,
      walletId: signed.walletId, rawTxHex: signed.rawTxHex, expectedTxid: signed.txid,
    }, options);
    if ((!broadcast.accepted && !broadcast.alreadyKnown) || broadcast.txid !== signed.txid || broadcast.walletId !== signed.walletId) {
      throw new ExchangeSdkError("broadcast response did not confirm the signed attempt", {
        code: "invalid_response", retryable: false,
        details: { attempt_id: status.attemptId },
      });
    }
    return { ...current, state: "broadcast", txid: broadcast.txid };
  }

  /** Bounded convenience loop; a timeout leaves the durable attempt active. */
  async processWithdrawal(input: WithdrawalInput, options: ProcessWithdrawalOptions = {}): Promise<WithdrawalStatus> {
    const interval = boundedTimer(positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs"), "pollIntervalMs");
    const wait = boundedTimer(positiveInteger(options.waitTimeoutMs ?? 2 * 60_000, "waitTimeoutMs"), "waitTimeoutMs");
    const timeout = boundedTimer(positiveInteger(options.timeoutMs ?? 30_000, "timeoutMs"), "timeoutMs");
    const deadline = Date.now() + wait;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, wait);
    let latest: WithdrawalStatus | undefined;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        latest = await this.advanceWithdrawal(input, { signal: controller.signal, timeoutMs: Math.min(timeout, remaining) });
        options.onStatus?.(latest);
        if (latest.state === "broadcast" || latest.state === "mined" || latest.state === "confirmed" ||
            latest.state === "failed" || latest.state === "blocked") return latest;
        await abortableDelay(Math.min(interval, Math.max(1, deadline - Date.now())), controller.signal, "exchange.process_withdrawal");
      }
    } catch (error) {
      if (!timedOut || options.signal?.aborted || !isExchangeSdkError(error) ||
          (error.code !== "client_aborted" && error.code !== "client_timeout")) throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    throw new ExchangeSdkError("Timed out waiting for withdrawal broadcast; the attempt remains active", {
      code: "withdrawal_wait_timeout", retryable: true, operation: "exchange.process_withdrawal",
      details: { withdrawal_id: input.withdrawalId,
        ...(latest === undefined ? {} : { attempt_id: latest.attemptId, state: latest.state,
          internal_state: latest.internalState, attempt_error: latest.error }) },
    });
  }
}
