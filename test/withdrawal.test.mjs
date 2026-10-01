import assert from "node:assert/strict";
import test from "node:test";
import { JunoExchangeClient, isExchangeSdkError } from "../dist/esm/index.js";
import { ATTEMPT_ID, TXID, WALLET_ID, attempt, failure, jsonResponse, junoAddress,
  requestJson, scriptedFetch, signedAttempt, success } from "./support.js";

const input = {
  withdrawalId: "68958548", walletId: WALLET_ID,
  toAddress: junoAddress(), amountZat: "20000",
};
const approval = "withdrawal:68958548";

function client(coordinatorFetch, gatewayFetch = scriptedFetch([]).fetch) {
  return new JunoExchangeClient({
    coordinator: { baseUrl: "https://coordinator.example", network: "regtest", fetch: coordinatorFetch },
    gateway: { baseUrl: "https://gateway.example", fetch: gatewayFetch },
  });
}

test("submitWithdrawal immediately returns an attempt and derives stable internal keys", async () => {
  const mock = scriptedFetch([jsonResponse(success(attempt({ approval_reference: approval }))),
    jsonResponse(success(attempt({ approval_reference: approval }))) ]);
  const exchange = client(mock.fetch);
  const first = await exchange.submitWithdrawal(input);
  const replay = await exchange.submitWithdrawal(input);
  assert.deepEqual(first, replay);
  assert.equal(first.state, "accepted");
  assert.equal(first.attemptId, ATTEMPT_ID);
  assert.deepEqual(mock.calls.map((call) => call.headers.get("idempotency-key")),
    ["withdrawal:68958548:create", "withdrawal:68958548:create"]);
  assert.deepEqual(requestJson(mock.calls[0]), {
    wallet_id: WALLET_ID, approval_reference: approval,
    outputs: [{ to_address: input.toAddress, amount_zat: "20000" }],
  });
  assert.equal(mock.calls.length, 2);
});

test("advanceWithdrawal broadcasts only exact expiry-checked signed material with a stable key", async () => {
  const signed = signedAttempt({ approval_reference: approval });
  const coordinator = scriptedFetch([
    jsonResponse(success(signed)), jsonResponse(success(signed)),
    jsonResponse(success(signed)), jsonResponse(success(signed)),
  ]);
  const gateway = scriptedFetch([
    jsonResponse(success({ wallet_id: WALLET_ID, txid: TXID, state: "mempool", accepted: true, already_known: false })),
    jsonResponse(success({ wallet_id: WALLET_ID, txid: TXID, state: "mempool", accepted: false, already_known: true })),
  ]);
  const exchange = client(coordinator.fetch, gateway.fetch);
  const first = await exchange.advanceWithdrawal(input);
  const second = await exchange.advanceWithdrawal(input);
  assert.equal(first.state, "broadcast");
  assert.equal(second.txid, TXID);
  assert.equal(first.attemptId, ATTEMPT_ID);
  assert.deepEqual(gateway.calls.map((call) => call.headers.get("idempotency-key")),
    ["withdrawal:68958548:broadcast", "withdrawal:68958548:broadcast"]);
  assert.deepEqual(requestJson(gateway.calls[0]), {
    wallet_id: WALLET_ID, expected_txid: TXID, raw_tx_hex: "00aabbcc",
  });
  assert.equal(second.state, "broadcast");
});

test("advanceWithdrawal does not broadcast signing uncertainty or expired material", async () => {
  for (const state of ["signing_unknown", "expired_pending_reconciliation", "failed_unsigned"]) {
    const coordinator = scriptedFetch([jsonResponse(success(attempt({ approval_reference: approval, state,
      error: { code: "signer_unavailable", message: "outcome unknown", retryable: true } }))) ]);
    const gateway = scriptedFetch([]);
    const status = await client(coordinator.fetch, gateway.fetch).advanceWithdrawal(input);
    const expected = state === "failed_unsigned" ? "failed" : "blocked";
    assert.equal(status.state, expected);
    assert.equal(status.error.code, "signer_unavailable");
    assert.equal(gateway.calls.length, 0);
  }
});

test("getWithdrawal validates its immutable business identity without modifying state", async () => {
  const coordinator = scriptedFetch([jsonResponse(success(attempt({ approval_reference: approval, state: "planning" }))) ]);
  const status = await client(coordinator.fetch).getWithdrawal(input.withdrawalId, ATTEMPT_ID);
  assert.equal(status.attemptId, ATTEMPT_ID);
  assert.equal(coordinator.calls[0].method, "GET");
  await assert.rejects(client(scriptedFetch([jsonResponse(success(attempt()))]).fetch)
    .getWithdrawal(input.withdrawalId, ATTEMPT_ID), (error) => isExchangeSdkError(error) && error.code === "invalid_response");
});

test("stable ID with a different request propagates idempotency conflict", async () => {
  const coordinator = scriptedFetch([jsonResponse(failure({ code: "idempotency_conflict", message: "changed payload", retryable: false }), 409) ]);
  await assert.rejects(client(coordinator.fetch).submitWithdrawal(input),
    (error) => isExchangeSdkError(error) && error.code === "idempotency_conflict");
});

test("withdrawalId validation rejects unsafe input before transport", async () => {
  const coordinator = scriptedFetch([]);
  for (const withdrawalId of ["", "bad key", "a".repeat(97), "é", "../abc"]) {
    await assert.rejects(client(coordinator.fetch).submitWithdrawal({ ...input, withdrawalId }),
      (error) => isExchangeSdkError(error) && error.code === "invalid_argument");
  }
  assert.equal(coordinator.calls.length, 0);
});

test("processWithdrawal reports progress and finishes at broadcast without waiting for finality", async () => {
  const coordinator = scriptedFetch([
    jsonResponse(success(attempt({ approval_reference: approval }))),
    jsonResponse(success(signedAttempt({ approval_reference: approval }))),
    jsonResponse(success(signedAttempt({ approval_reference: approval }))),
  ]);
  const gateway = scriptedFetch([jsonResponse(success({ wallet_id: WALLET_ID, txid: TXID,
    state: "mempool", accepted: true, already_known: false }))]);
  const statuses = [];
  const status = await client(coordinator.fetch, gateway.fetch).processWithdrawal(input,
    { pollIntervalMs: 1, waitTimeoutMs: 200, onStatus: (item) => statuses.push(item.state) });
  assert.equal(status.state, "broadcast");
  assert.deepEqual(statuses, ["accepted", "broadcast"]);
});

test("processWithdrawal timeout includes the durable attempt and last error", async () => {
  const fetch = async () => jsonResponse(success(attempt({ approval_reference: approval,
    state: "planning", error: { code: "planner_timeout", message: "planner retrying", retryable: true } })));
  await assert.rejects(client(fetch).processWithdrawal(input, { pollIntervalMs: 1, waitTimeoutMs: 8 }), (error) => {
    assert.ok(isExchangeSdkError(error));
    assert.equal(error.code, "withdrawal_wait_timeout");
    assert.equal(error.details.attempt_id, ATTEMPT_ID);
    assert.equal(error.details.internal_state, "planning");
    assert.equal(error.details.attempt_error.code, "planner_timeout");
    return true;
  });
});

test("a stalled authToken provider is bounded by the request timeout", async () => {
  const mock = scriptedFetch([]);
  const exchange = new JunoExchangeClient({
    coordinator: { baseUrl: "https://coordinator.example", network: "regtest", authToken: () => new Promise(() => {}),
      fetch: mock.fetch, retry: { maxAttempts: 1 } },
    gateway: { baseUrl: "https://gateway.example", fetch: scriptedFetch([]).fetch },
  });
  await assert.rejects(exchange.submitWithdrawal(input, { timeoutMs: 5 }),
    (error) => isExchangeSdkError(error) && error.code === "client_timeout");
  assert.equal(mock.calls.length, 0);
});

test("an auth provider that finishes after the deadline does not start fetch", async () => {
  const mock = scriptedFetch([]);
  const exchange = new JunoExchangeClient({
    coordinator: { baseUrl: "https://coordinator.example", network: "regtest",
      authToken: () => new Promise((resolve) => setTimeout(() => resolve("late-token"), 20)),
      fetch: mock.fetch, retry: { maxAttempts: 1 } },
    gateway: { baseUrl: "https://gateway.example", fetch: scriptedFetch([]).fetch },
  });
  await assert.rejects(exchange.submitWithdrawal(input, { timeoutMs: 5 }),
    (error) => isExchangeSdkError(error) && error.code === "client_timeout");
  assert.equal(mock.calls.length, 0);
});

test("a custom fetch that ignores AbortSignal is still bounded by the request timeout", async () => {
  const exchange = new JunoExchangeClient({
    coordinator: { baseUrl: "https://coordinator.example", network: "regtest",
      fetch: () => new Promise(() => {}), retry: { maxAttempts: 1 } },
    gateway: { baseUrl: "https://gateway.example", fetch: scriptedFetch([]).fetch },
  });
  await assert.rejects(exchange.submitWithdrawal(input, { timeoutMs: 5 }),
    (error) => isExchangeSdkError(error) && error.code === "client_timeout");
});

test("advanceNoteSplit creates the split under stable keys and broadcasts once signed", async () => {
  const splitInput = { splitId: "fanout-1", walletId: WALLET_ID, noteCount: 3, noteZat: "1000000" };
  const signed = signedAttempt({ approval_reference: "split:fanout-1",
    orchard_output_action_indices: [0, 2, 3], orchard_change_action_index: 1 });
  const coordinator = scriptedFetch([jsonResponse(success(signed)), jsonResponse(success(signed))]);
  const gateway = scriptedFetch([
    jsonResponse(success({ wallet_id: WALLET_ID, txid: TXID, state: "mempool", accepted: true, already_known: false })),
  ]);
  const status = await client(coordinator.fetch, gateway.fetch).advanceNoteSplit(splitInput);
  assert.equal(status.state, "broadcast");
  assert.equal(status.splitId, "fanout-1");
  assert.equal(status.withdrawalId, undefined);
  assert.equal(coordinator.calls[0].headers.get("idempotency-key"), "split:fanout-1:create");
  assert.deepEqual(requestJson(coordinator.calls[0]), {
    wallet_id: WALLET_ID, approval_reference: "split:fanout-1",
    split: { note_count: 3, note_zat: "1000000" },
  });
  assert.equal(gateway.calls[0].headers.get("idempotency-key"), "split:fanout-1:broadcast");
});

test("advanceNoteSplit refuses to broadcast when the output mapping does not match the split", async () => {
  const splitInput = { splitId: "fanout-2", walletId: WALLET_ID, noteCount: 3, noteZat: "1000000" };
  const signed = signedAttempt({ approval_reference: "split:fanout-2",
    orchard_output_action_indices: [0, 2], orchard_change_action_index: 1 });
  const coordinator = scriptedFetch([jsonResponse(success(signed)), jsonResponse(success(signed))]);
  const gateway = scriptedFetch([]);
  await assert.rejects(client(coordinator.fetch, gateway.fetch).advanceNoteSplit(splitInput),
    (error) => isExchangeSdkError(error) && error.code === "invalid_response");
  assert.equal(gateway.calls.length, 0);
});

test("advanceWithdrawal leaves notes_reserved attempts accepted for the next pass", async () => {
  const coordinator = scriptedFetch([jsonResponse(success(attempt({ approval_reference: approval,
    state: "planning", error: { code: "notes_reserved", message: "eligible notes are reserved", retryable: true } })))]);
  const gateway = scriptedFetch([]);
  const status = await client(coordinator.fetch, gateway.fetch).advanceWithdrawal(input);
  assert.equal(status.state, "accepted");
  assert.equal(status.error.code, "notes_reserved");
  assert.equal(gateway.calls.length, 0);
});
