import assert from "node:assert/strict";
import test from "node:test";

import { GatewayClient, isExchangeSdkError } from "../dist/esm/index.js";
import {
  TXID,
  WALLET_ID,
  failure,
  jsonResponse,
  requestJson,
  scriptedFetch,
  success,
} from "./support.js";

const baseUrl = "https://gateway.example";

function broadcastResult(overrides = {}) {
  return {
    wallet_id: WALLET_ID,
    txid: TXID,
    state: "mempool",
    accepted: true,
    already_known: false,
    ...overrides,
  };
}

function walletBalanceResult(overrides = {}) {
  return {
    wallet_id: WALLET_ID,
    min_confirmations: 100,
    min_note_zat: 100001,
    as_of_node_height: 920000,
    as_of_scanner_height: 920000,
    as_of_scanner_hash: "d".repeat(64),
    scanner_lag: 0,
    total_unspent: { note_count: 7, value_zat: 42000000000 },
    spendable: {
      note_count: 3,
      value_zat: 39000000000,
      smallest_note_zat: 1000000000,
      largest_note_zat: 30000000000,
    },
    immature: { note_count: 1, value_zat: 1200000000 },
    pending_spend: {
      note_count: 1,
      value_zat: 1500000000,
      known_expiry_count: 1,
      next_expiry_height: 920035,
      last_expiry_height: 920035,
    },
    below_min_note: { note_count: 1, value_zat: 99999 },
    witness_unavailable: { note_count: 1, value_zat: 299900001 },
    ...overrides,
  };
}

test("broadcast sends the existing gateway contract and parses its result", async () => {
  const mock = scriptedFetch([jsonResponse(success(broadcastResult()))]);
  const client = new GatewayClient({
    baseUrl,
    authToken: async () => "gateway-token",
    fetch: mock.fetch,
  });

  const result = await client.broadcast({
    idempotencyKey: "withdrawal-1842-broadcast-1",
    walletId: WALLET_ID,
    rawTxHex: "00aabbcc",
    expectedTxid: TXID,
    requestId: "exchange-broadcast-1842",
  });

  assert.deepEqual(result, {
    walletId: WALLET_ID,
    txid: TXID,
    state: "mempool",
    accepted: true,
    alreadyKnown: false,
  });
  const [call] = mock.calls;
  assert.equal(call.url, `${baseUrl}/v1/transactions/broadcast`);
  assert.equal(call.headers.get("authorization"), "Bearer gateway-token");
  assert.equal(call.headers.get("idempotency-key"), "withdrawal-1842-broadcast-1");
  assert.equal(call.headers.get("x-request-id"), "exchange-broadcast-1842");
  assert.deepEqual(requestJson(call), {
    wallet_id: WALLET_ID,
    raw_tx_hex: "00aabbcc",
    expected_txid: TXID,
  });
});

test("lookupTransaction uses wallet scope and maps transaction metadata", async () => {
  const blockHash = "d".repeat(64);
  const mock = scriptedFetch([
    jsonResponse(
      success({
        wallet_id: WALLET_ID,
        transaction: {
          txid: TXID,
          state: "confirmed",
          confirmations: 101,
          block_hash: blockHash,
          block_height: 500,
          block_time: 1_700_000_000,
          expiry_height: 1_234,
          serialized_size: 2_048,
          orchard_action_count: 2,
          raw_tx_hex: "00aabbcc",
        },
        wallet_effects: [{ kind: "spend", amount_zat: "260000" }],
      }),
    ),
  ]);
  const client = new GatewayClient({ baseUrl, fetch: mock.fetch });

  const result = await client.lookupTransaction(TXID, {
    walletId: WALLET_ID,
    includeRaw: true,
    requestId: "lookup-1",
  });

  assert.equal(
    mock.calls[0].url,
    `${baseUrl}/v1/transactions/${TXID}?wallet_id=hot-wallet-1&include_raw=true`,
  );
  assert.equal(mock.calls[0].headers.get("x-request-id"), "lookup-1");
  assert.deepEqual(result, {
    walletId: WALLET_ID,
    transaction: {
      txid: TXID,
      state: "confirmed",
      confirmations: 101,
      blockHash,
      blockHeight: 500,
      blockTime: 1_700_000_000,
      expiryHeight: 1_234,
      serializedSize: 2_048,
      orchardActionCount: 2,
      rawTxHex: "00aabbcc",
    },
    walletEffects: [{ kind: "spend", amount_zat: "260000" }],
  });
});

test("getWalletBalance requests and maps the atomic wallet note summary", async () => {
  const mock = scriptedFetch([jsonResponse(success(walletBalanceResult()))]);
  const client = new GatewayClient({
    baseUrl,
    authToken: "treasury-token",
    fetch: mock.fetch,
  });

  const result = await client.getWalletBalance(WALLET_ID, {
    minConfirmations: 100,
    minNoteZat: 100001n,
    requestId: "wallet-balance-1",
  });

  assert.deepEqual(result, {
    walletId: WALLET_ID,
    minConfirmations: 100,
    minNoteZat: "100001",
    asOfNodeHeight: 920000,
    asOfScannerHeight: 920000,
    asOfScannerHash: "d".repeat(64),
    scannerLag: 0,
    totalUnspent: { noteCount: 7, valueZat: "42000000000" },
    spendable: {
      noteCount: 3,
      valueZat: "39000000000",
      smallestNoteZat: "1000000000",
      largestNoteZat: "30000000000",
    },
    immature: { noteCount: 1, valueZat: "1200000000" },
    pendingSpend: {
      noteCount: 1,
      valueZat: "1500000000",
      knownExpiryCount: 1,
      nextExpiryHeight: 920035,
      lastExpiryHeight: 920035,
    },
    belowMinNote: { noteCount: 1, valueZat: "99999" },
    witnessUnavailable: { noteCount: 1, valueZat: "299900001" },
  });
  assert.equal(
    mock.calls[0].url,
    `${baseUrl}/v1/wallets/${WALLET_ID}/notes/summary?min_confirmations=100&min_note_zat=100001`,
  );
  assert.equal(mock.calls[0].headers.get("authorization"), "Bearer treasury-token");
  assert.equal(mock.calls[0].headers.get("x-request-id"), "wallet-balance-1");
  assert.equal(mock.calls[0].body, undefined);
});

test("getWalletBalance preserves gateway defaults and empty optional buckets", async () => {
  const mock = scriptedFetch([
    jsonResponse(
      success(
        walletBalanceResult({
          min_note_zat: 0,
          total_unspent: { note_count: 0, value_zat: 0 },
          spendable: { note_count: 0, value_zat: 0 },
          immature: { note_count: 0, value_zat: 0 },
          pending_spend: { note_count: 0, value_zat: 0, known_expiry_count: 0 },
          below_min_note: { note_count: 0, value_zat: 0 },
          witness_unavailable: { note_count: 0, value_zat: 0 },
        }),
      ),
    ),
  ]);
  const client = new GatewayClient({ baseUrl, fetch: mock.fetch });

  const result = await client.getWalletBalance(WALLET_ID);

  assert.equal(mock.calls[0].url, `${baseUrl}/v1/wallets/${WALLET_ID}/notes/summary`);
  assert.deepEqual(result.spendable, { noteCount: 0, valueZat: "0" });
  assert.deepEqual(result.pendingSpend, {
    noteCount: 0,
    valueZat: "0",
    knownExpiryCount: 0,
  });
});

test("getWalletBalance validates options before making a request", async () => {
  const cases = [
    { minConfirmations: -1 },
    { minConfirmations: 1.5 },
    { minConfirmations: 10001 },
    { minConfirmations: "100" },
    { minNoteZat: 100001 },
    { minNoteZat: "-1" },
    { minNoteZat: "0100001" },
    { minNoteZat: " 100001 " },
    { minNoteZat: "9223372036854775808" },
  ];

  for (const options of cases) {
    const mock = scriptedFetch([]);
    const client = new GatewayClient({ baseUrl, fetch: mock.fetch });
    await assert.rejects(client.getWalletBalance(WALLET_ID, options), (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "invalid_argument");
      return true;
    });
    assert.equal(mock.calls.length, 0);
  }
});

test("getWalletBalance preserves signed-64-bit zatoshi values exactly", async () => {
  const exactValue = "9007199254740993";
  const response = success(
    walletBalanceResult({
      min_note_zat: exactValue,
      total_unspent: { note_count: 1, value_zat: exactValue },
      spendable: {
        note_count: 1,
        value_zat: exactValue,
        smallest_note_zat: exactValue,
        largest_note_zat: exactValue,
      },
      immature: { note_count: 0, value_zat: "0" },
      pending_spend: {
        note_count: 0,
        value_zat: "0",
        known_expiry_count: 0,
      },
      below_min_note: { note_count: 0, value_zat: "0" },
      witness_unavailable: { note_count: 0, value_zat: "0" },
    }),
  );
  const wire = JSON.stringify(response).replace(
    /"(min_note_zat|value_zat|smallest_note_zat|largest_note_zat)":"([0-9]+)"/g,
    '"$1":$2',
  );
  const mock = scriptedFetch([
    new Response(wire, { status: 200, headers: { "Content-Type": "application/json" } }),
  ]);
  const client = new GatewayClient({ baseUrl, fetch: mock.fetch });

  const result = await client.getWalletBalance(WALLET_ID, { minNoteZat: exactValue });

  assert.equal(result.minNoteZat, exactValue);
  assert.equal(result.totalUnspent.valueZat, exactValue);
  assert.equal(result.spendable.valueZat, exactValue);
  assert.equal(result.spendable.smallestNoteZat, exactValue);
  assert.equal(result.spendable.largestNoteZat, exactValue);
});

test("getWalletBalance rejects invalid or internally inconsistent responses", async () => {
  const cases = [
    walletBalanceResult({ wallet_id: "other-wallet" }),
    walletBalanceResult({ min_confirmations: 99 }),
    walletBalanceResult({ total_unspent: { note_count: 7, value_zat: 9007199254740992 } }),
    walletBalanceResult({ total_unspent: { note_count: 7, value_zat: 41999999999 } }),
    walletBalanceResult({ as_of_scanner_height: 919999, scanner_lag: 0 }),
    walletBalanceResult({ spendable: { note_count: 3, value_zat: 39000000000 } }),
    walletBalanceResult({
      pending_spend: {
        note_count: 1,
        value_zat: 1500000000,
        known_expiry_count: 1,
      },
    }),
    walletBalanceResult({ as_of_scanner_hash: "D".repeat(64) }),
  ];

  for (const response of cases) {
    const mock = scriptedFetch([jsonResponse(success(response))]);
    const client = new GatewayClient({ baseUrl, fetch: mock.fetch });
    await assert.rejects(
      client.getWalletBalance(WALLET_ID, {
        minConfirmations: 100,
        minNoteZat: "100001",
      }),
      (error) => {
        assert.ok(isExchangeSdkError(error));
        assert.equal(error.code, "invalid_response");
        return true;
      },
    );
  }
});

test("broadcast retries only named safe gateway failures with an identical body", async () => {
  const mock = scriptedFetch([
    jsonResponse(
      failure({
        code: "node_not_ready",
        message: "node is synchronizing",
        retryable: true,
        details: { retry_after_seconds: 0 },
      }),
      503,
    ),
    jsonResponse(success(broadcastResult({ already_known: true }))),
  ]);
  const client = new GatewayClient({
    baseUrl,
    fetch: mock.fetch,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
  });

  const result = await client.broadcast({
    idempotencyKey: "broadcast-stable-1",
    walletId: WALLET_ID,
    rawTxHex: "00aabbcc",
    expectedTxid: TXID,
  });

  assert.equal(result.alreadyKnown, true);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].body, mock.calls[1].body);
  assert.equal(mock.calls[0].headers.get("idempotency-key"), "broadcast-stable-1");
  assert.equal(mock.calls[1].headers.get("idempotency-key"), "broadcast-stable-1");
});

test("broadcast does not retry an unspecified HTTP 500 failure", async () => {
  const mock = scriptedFetch([
    jsonResponse(
      failure({ code: "internal_server_error", message: "failed", retryable: true }),
      500,
    ),
  ]);
  const client = new GatewayClient({
    baseUrl,
    fetch: mock.fetch,
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  });

  await assert.rejects(
    client.broadcast({
      idempotencyKey: "broadcast-no-retry-1",
      walletId: WALLET_ID,
      rawTxHex: "00aabbcc",
      expectedTxid: TXID,
    }),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "internal_server_error");
      assert.equal(error.status, 500);
      return true;
    },
  );
  assert.equal(mock.calls.length, 1);
});

test("read requests retry transient network failures", async () => {
  const mock = scriptedFetch([
    new TypeError("connection reset"),
    jsonResponse(
      success({
        transaction: { txid: TXID, state: "mempool", confirmations: 0 },
      }),
    ),
  ]);
  const client = new GatewayClient({
    baseUrl,
    fetch: mock.fetch,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
  });

  const result = await client.lookupTransaction(TXID);
  assert.equal(result.transaction.state, "mempool");
  assert.equal(mock.calls.length, 2);
});

test("lookup rejects invalid response data and invalid includeRaw before returning it", async () => {
  const invalidResponseMock = scriptedFetch([
    jsonResponse(
      success({ transaction: { txid: TXID, state: "mempool", confirmations: -1 } }),
    ),
  ]);
  const client = new GatewayClient({ baseUrl, fetch: invalidResponseMock.fetch });
  await assert.rejects(client.lookupTransaction(TXID), (error) => {
    assert.ok(isExchangeSdkError(error));
    assert.equal(error.code, "invalid_response");
    return true;
  });

  const noCallMock = scriptedFetch([]);
  const validatingClient = new GatewayClient({ baseUrl, fetch: noCallMock.fetch });
  await assert.rejects(
    validatingClient.lookupTransaction(TXID, { includeRaw: "yes" }),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "invalid_argument");
      return true;
    },
  );
  assert.equal(noCallMock.calls.length, 0);
});

test("oversized responses fail closed", async () => {
  const body = JSON.stringify(success(broadcastResult()));
  const mock = scriptedFetch([
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
    }),
  ]);
  const client = new GatewayClient({ baseUrl, fetch: mock.fetch, maxResponseBytes: 16 });

  await assert.rejects(
    client.broadcast({
      idempotencyKey: "broadcast-size-limit-1",
      walletId: WALLET_ID,
      rawTxHex: "00aabbcc",
      expectedTxid: TXID,
    }),
    (error) => {
      assert.ok(isExchangeSdkError(error));
      assert.equal(error.code, "response_too_large");
      return true;
    },
  );
});

test("timeouts while reading a response body retain the client timeout code", async () => {
  const fetch = async (_input, init) => ({
    status: 200,
    ok: true,
    headers: new Headers(),
    text: () =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  const client = new GatewayClient({
    baseUrl,
    fetch,
    defaultTimeoutMs: 5,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });

  await assert.rejects(client.lookupTransaction(TXID), (error) => {
    assert.ok(isExchangeSdkError(error));
    assert.equal(error.code, "client_timeout");
    assert.equal(error.retryable, true);
    return true;
  });
});
