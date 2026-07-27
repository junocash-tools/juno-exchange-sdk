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
