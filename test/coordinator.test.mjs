import assert from "node:assert/strict";
import test from "node:test";

import {
  CoordinatorClient,
  ExchangeSdkError,
  isExchangeSdkError,
} from "../dist/esm/index.js";
import {
  APPROVAL_REFERENCE,
  ATTEMPT_ID,
  PLAN_DIGEST,
  TXID,
  WALLET_ID,
  attempt,
  failure,
  jsonResponse,
  junoAddress,
  requestJson,
  scriptedFetch,
  signedAttempt,
  success,
} from "./support.js";

const baseUrl = "https://coordinator.example/private/";

function coordinator(fetch) {
  return new CoordinatorClient({ baseUrl: "https://coordinator.example", network: "regtest", fetch });
}

test("createAttempt maps exact wire fields, auth, request ID, and bigint amounts", async () => {
  const destination = junoAddress("regtest");
  const mock = scriptedFetch([jsonResponse(success(attempt()))]);
  const client = new CoordinatorClient({
    baseUrl,
    authToken: "coordinator-token",
    network: "regtest",
    fetch: mock.fetch,
  });

  const result = await client.createAttempt({
    idempotencyKey: "withdrawal-1842-attempt-1",
    walletId: WALLET_ID,
    approvalReference: APPROVAL_REFERENCE,
    requestId: "exchange-request-1842",
    outputs: [{ toAddress: destination, amountZat: 250000n, memoHex: "6869" }],
  });

  assert.equal(result.attemptId, ATTEMPT_ID);
  assert.equal(mock.calls.length, 1);
  const [call] = mock.calls;
  assert.equal(call.url, `${baseUrl.slice(0, -1)}/v1/transaction-attempts`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers.get("authorization"), "Bearer coordinator-token");
  assert.equal(call.headers.get("idempotency-key"), "withdrawal-1842-attempt-1");
  assert.equal(call.headers.get("x-request-id"), "exchange-request-1842");
  assert.deepEqual(requestJson(call), {
    wallet_id: WALLET_ID,
    approval_reference: APPROVAL_REFERENCE,
    outputs: [{ to_address: destination, amount_zat: "250000", memo_hex: "6869" }],
  });
});

test("createAttempt retries retryable idempotent failures with identical key and body", async () => {
  const destination = junoAddress();
  const events = [];
  const first = jsonResponse(
    failure({
      code: "node_not_ready",
      message: "node is synchronizing",
      retryable: true,
      details: { retry_after_seconds: 0 },
    }),
    503,
  );
  const mock = scriptedFetch([first, jsonResponse(success(attempt()))]);
  const client = new CoordinatorClient({
    baseUrl,
    authToken: "never-log-this-token",
    fetch: mock.fetch,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    logger: (event) => events.push(event),
  });

  await client.createAttempt({
    idempotencyKey: "stable-key-1842",
    walletId: WALLET_ID,
    approvalReference: APPROVAL_REFERENCE,
    outputs: [{ toAddress: destination, amountZat: "250000" }],
  });

  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].body, mock.calls[1].body);
  assert.equal(mock.calls[0].headers.get("idempotency-key"), "stable-key-1842");
  assert.equal(mock.calls[1].headers.get("idempotency-key"), "stable-key-1842");
  assert.deepEqual(events.map(({ event }) => event), ["request_retry", "request_complete"]);
  const logged = JSON.stringify(events);
  for (const secret of ["never-log-this-token", destination, "stable-key-1842", "250000"]) {
    assert.equal(logged.includes(secret), false);
  }
});

test("createRawTransaction polls until a complete signed result is available", async () => {
  const mock = scriptedFetch([
    jsonResponse(success(attempt({ state: "reserved" }))),
    jsonResponse(success(attempt({ state: "signing" }))),
    jsonResponse(success(signedAttempt({ orchard_change_action_index: null }))),
  ]);
  const client = new CoordinatorClient({ baseUrl, network: "regtest", fetch: mock.fetch });

  const result = await client.createRawTransaction(
    {
      idempotencyKey: "withdrawal-1842-attempt-1",
      walletId: WALLET_ID,
      approvalReference: APPROVAL_REFERENCE,
      toAddress: junoAddress("regtest"),
      amountZat: "250000",
    },
    { pollIntervalMs: 1, waitTimeoutMs: 250 },
  );

  assert.deepEqual(result, {
    attemptId: ATTEMPT_ID,
    walletId: WALLET_ID,
    approvalReference: APPROVAL_REFERENCE,
    state: "signed",
    changeAddress: junoAddress("regtest"),
    feeZat: "10000",
    expiryHeight: 1_234,
    planDigest: PLAN_DIGEST,
    selectedNoteIds: [`${"c".repeat(64)}:0`],
    txid: TXID,
    rawTxHex: "00aabbcc",
    orchardOutputActionIndices: [0],
    orchardChangeActionIndex: null,
  });
  assert.deepEqual(mock.calls.map(({ method }) => method), ["POST", "GET", "GET"]);
});

test("createRawTransaction reports terminal attempt states without broadcasting", async () => {
  const attemptError = {
    code: "insufficient_balance",
    message: "the hot wallet has insufficient spendable balance",
    retryable: false,
  };
  const mock = scriptedFetch([
    jsonResponse(success(attempt({ state: "failed_unsigned", error: attemptError }))),
  ]);
  const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });

  await assert.rejects(
    client.createRawTransaction({
      idempotencyKey: "withdrawal-1842-attempt-1",
      walletId: WALLET_ID,
      approvalReference: APPROVAL_REFERENCE,
      toAddress: junoAddress(),
      amountZat: "250000",
    }),
    (error) => {
      assert.ok(error instanceof ExchangeSdkError);
      assert.equal(error.code, "transaction_attempt_failed_unsigned");
      assert.equal(error.retryable, false);
      assert.equal(error.message, attemptError.message);
      assert.deepEqual(error.details, {
        attempt_id: ATTEMPT_ID,
        state: "failed_unsigned",
        attempt_error: attemptError,
      });
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("createRawTransaction replays durable signed material after broadcast", async () => {
  const mock = scriptedFetch([
    jsonResponse(
      success(signedAttempt({ state: "broadcast", orchard_change_action_index: undefined })),
    ),
  ]);
  const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });

  const result = await client.createRawTransaction({
    idempotencyKey: "withdrawal-broadcast-replay-1",
    walletId: WALLET_ID,
    approvalReference: APPROVAL_REFERENCE,
    toAddress: junoAddress(),
    amountZat: "250000",
  });

  assert.equal(result.state, "broadcast");
  assert.equal(result.rawTxHex, "00aabbcc");
  assert.equal(result.orchardChangeActionIndex, null);
  assert.equal(mock.calls.length, 1);
});

test("createRawTransaction rejects expired signed material", async () => {
  const mock = scriptedFetch([
    jsonResponse(success(signedAttempt({ state: "expired_pending_reconciliation" }))),
  ]);
  const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });

  await assert.rejects(
    client.createRawTransaction({
      idempotencyKey: "withdrawal-expired-replay-1",
      walletId: WALLET_ID,
      approvalReference: APPROVAL_REFERENCE,
      toAddress: junoAddress(),
      amountZat: "250000",
    }),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "transaction_attempt_expired_pending_reconciliation");
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("createRawTransaction timeout leaves the coordinator attempt active", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return jsonResponse(success(attempt({ state: "planning" })));
  };
  const client = new CoordinatorClient({ baseUrl, fetch });

  await assert.rejects(
    client.createRawTransaction(
      {
        idempotencyKey: "withdrawal-timeout-1",
        walletId: WALLET_ID,
        approvalReference: APPROVAL_REFERENCE,
        toAddress: junoAddress(),
        amountZat: "250000",
      },
      { pollIntervalMs: 2, waitTimeoutMs: 5 },
    ),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "attempt_wait_timeout");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, { attempt_id: ATTEMPT_ID, state: "planning" });
      return true;
    },
  );
  assert.ok(calls >= 1);
});

test("createRawTransaction rejects timer values that Node would clamp", async () => {
  const mock = scriptedFetch([]);
  const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });
  const input = {
    idempotencyKey: "withdrawal-timer-limit",
    walletId: WALLET_ID,
    approvalReference: APPROVAL_REFERENCE,
    toAddress: junoAddress(),
    amountZat: "250000",
  };
  for (const options of [{ pollIntervalMs: 2_147_483_648 }, { waitTimeoutMs: 2_147_483_648 }]) {
    await assert.rejects(client.createRawTransaction(input, options),
      (error) => isExchangeSdkError(error) && error.code === "invalid_argument");
  }
  assert.equal(mock.calls.length, 0);
});

test("createRawTransaction honors AbortSignal while polling", async () => {
  const mock = scriptedFetch([jsonResponse(success(attempt({ state: "planning" })))]);
  const controller = new AbortController();
  const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });
  setTimeout(() => controller.abort("shutdown"), 5);

  await assert.rejects(
    client.createRawTransaction(
      {
        idempotencyKey: "withdrawal-abort-1",
        walletId: WALLET_ID,
        approvalReference: APPROVAL_REFERENCE,
        toAddress: junoAddress(),
        amountZat: "250000",
      },
      { pollIntervalMs: 100, waitTimeoutMs: 500, signal: controller.signal },
    ),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "client_aborted");
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("cancelAttempt is not automatically retried", async () => {
  const mock = scriptedFetch([
    jsonResponse(
      failure({ code: "node_not_ready", message: "try later", retryable: true }),
      503,
    ),
  ]);
  const client = new CoordinatorClient({
    baseUrl,
    fetch: mock.fetch,
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  });

  await assert.rejects(client.cancelAttempt(ATTEMPT_ID), (error) => {
    assert.ok(isExchangeSdkError(error));
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(mock.calls.length, 1);
});

test("listActiveAttempts maps private diagnostics without signed raw material", async () => {
  const mock = scriptedFetch([
    jsonResponse(success({
      wallet_id: WALLET_ID,
      attempts: [signedAttempt({ raw_tx_hex: undefined })],
    })),
  ]);
  const client = coordinator(mock.fetch);
  const result = await client.listActiveAttempts(WALLET_ID);
  assert.equal(result.walletId, WALLET_ID);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].attemptId, ATTEMPT_ID);
  assert.equal(result.attempts[0].rawTxHex, undefined);
  assert.equal(mock.calls[0].method, "GET");
  assert.equal(
    mock.calls[0].url,
    `https://coordinator.example/v1/wallets/${WALLET_ID}/transaction-attempts/active`,
  );
});

test("listActiveAttempts rejects raw transaction leakage and wallet mismatch", async () => {
  for (const data of [
    { wallet_id: WALLET_ID, attempts: [signedAttempt()] },
    { wallet_id: "another-wallet", attempts: [] },
  ]) {
    const mock = scriptedFetch([jsonResponse(success(data))]);
    await assert.rejects(
      coordinator(mock.fetch).listActiveAttempts(WALLET_ID),
      (error) => isExchangeSdkError(error) && error.code === "invalid_response",
    );
  }
});

test("API failures retain typed status, code, request ID, retryability, and details", async () => {
  const details = { existing_attempt_id: "attempt-existing" };
  const mock = scriptedFetch([
    jsonResponse(
      failure(
        {
          code: "idempotency_conflict",
          message: "key was used with different parameters",
          retryable: false,
          details,
        },
        "request-conflict-1",
      ),
      409,
    ),
  ]);
  const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });

  await assert.rejects(
    client.createAttempt({
      idempotencyKey: "withdrawal-conflict-1",
      walletId: WALLET_ID,
      approvalReference: APPROVAL_REFERENCE,
      outputs: [{ toAddress: junoAddress(), amountZat: "250000" }],
    }),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.status, 409);
      assert.equal(error.code, "idempotency_conflict");
      assert.equal(error.requestId, "request-conflict-1");
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, details);
      assert.equal("responseBody" in error, false);
      return true;
    },
  );
});

test("strict validation rejects unsafe amount types, non-canonical amounts, memos, and networks", async () => {
  const mock = scriptedFetch([]);
  const client = new CoordinatorClient({
    baseUrl,
    network: "mainnet",
    fetch: mock.fetch,
  });
  const validBase = {
    idempotencyKey: "withdrawal-invalid-1",
    walletId: WALLET_ID,
    approvalReference: APPROVAL_REFERENCE,
  };

  for (const output of [
    { toAddress: junoAddress("mainnet"), amountZat: 250000 },
    { toAddress: junoAddress("mainnet"), amountZat: "0250000" },
    { toAddress: junoAddress("mainnet"), amountZat: "18446744073709551616" },
    { toAddress: junoAddress("mainnet"), amountZat: "250000", memoHex: "ABC" },
    { toAddress: junoAddress("testnet"), amountZat: "250000" },
  ]) {
    await assert.rejects(
      client.createAttempt({ ...validBase, outputs: [output] }),
      (error) => {
        assert.ok(isExchangeSdkError(error));
        assert.equal(error.code, "invalid_argument");
        return true;
      },
    );
  }
  await assert.rejects(
    client.createAttempt({
      ...validBase,
      outputs: [
        { toAddress: junoAddress("mainnet"), amountZat: "18446744073709551615" },
        { toAddress: junoAddress("mainnet"), amountZat: "1" },
      ],
    }),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "invalid_argument");
      return true;
    },
  );
  assert.equal(mock.calls.length, 0);
});

test("attempt IDs and approval references follow the coordinator contract", async () => {
  const approvalReference = "ops approval #1842 (desk α)";
  const destination = junoAddress();
  const mock = scriptedFetch([jsonResponse(success(attempt({ approval_reference: approvalReference })))]);
  const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });

  const result = await client.createAttempt({
    idempotencyKey: "approval-reference-1",
    walletId: WALLET_ID,
    approvalReference,
    outputs: [{ toAddress: destination, amountZat: "250000" }],
  });
  assert.equal(result.approvalReference, approvalReference);
  assert.equal(requestJson(mock.calls[0]).approval_reference, approvalReference);

  await assert.rejects(client.status("attempt-1842-1"), (error) => {
    assert.ok(isExchangeSdkError(error));
    assert.equal(error.code, "invalid_argument");
    return true;
  });
  await assert.rejects(
    client.createAttempt({
      idempotencyKey: "approval-reference-oversize-1",
      walletId: WALLET_ID,
      approvalReference: "💰".repeat(33),
      outputs: [{ toAddress: destination, amountZat: "250000" }],
    }),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "invalid_argument");
      return true;
    },
  );
});

test("malformed attempt IDs in coordinator responses fail closed", async () => {
  const mock = scriptedFetch([
    jsonResponse(success(attempt({ attempt_id: "attempt-1842-1" }))),
  ]);
  const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });

  await assert.rejects(
    client.createAttempt({
      idempotencyKey: "malformed-attempt-response-1",
      walletId: WALLET_ID,
      approvalReference: APPROVAL_REFERENCE,
      outputs: [{ toAddress: junoAddress(), amountZat: "250000" }],
    }),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );
});

test("required response metadata and positive expiry heights fail closed", async () => {
  for (const response of [
    { status: "ok", data: attempt() },
    success(attempt({ created_at: undefined })),
    success(attempt({ updated_at: "not-a-timestamp" })),
    success(signedAttempt({ expiry_height: 0 })),
  ]) {
    const mock = scriptedFetch([jsonResponse(response)]);
    const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });
    await assert.rejects(
      client.createAttempt({
        idempotencyKey: "malformed-response-metadata-1",
        walletId: WALLET_ID,
        approvalReference: APPROVAL_REFERENCE,
        outputs: [{ toAddress: junoAddress(), amountZat: "250000" }],
      }),
      (error) => {
        assert.ok(isExchangeSdkError(error));
        assert.equal(error.code, "invalid_response");
        return true;
      },
    );
  }
});

test("signed state is rejected when reconciliation fields are incomplete", async () => {
  const incomplete = signedAttempt();
  delete incomplete.orchard_output_action_indices;
  const mock = scriptedFetch([jsonResponse(success(incomplete))]);
  const client = new CoordinatorClient({ baseUrl, fetch: mock.fetch });

  await assert.rejects(
    client.createRawTransaction({
      idempotencyKey: "withdrawal-incomplete-1",
      walletId: WALLET_ID,
      approvalReference: APPROVAL_REFERENCE,
      toAddress: junoAddress(),
      amountZat: "250000",
    }),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "invalid_response");
      return true;
    },
  );
});
