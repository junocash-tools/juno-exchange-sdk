# Juno Exchange SDK

Typed Node.js access to the private transaction coordinator and public Juno exchange gateway. It lets an exchange request a signed raw transaction, then broadcast and track it without running a CLI command per withdrawal.

The SDK does not hold keys, scan the chain, select notes, calculate fees, or sign locally. Those operations stay behind the private coordinator. The gateway remains a read-and-broadcast boundary.

## Install

```sh
npm install @junocash-tools/exchange-sdk
```

Node.js 20 or later is required. ESM, CommonJS, and TypeScript declarations are included. The package has no runtime dependencies and sends no telemetry.

## Create a raw transaction

```js
import { CoordinatorClient } from "@junocash-tools/exchange-sdk";

const coordinator = new CoordinatorClient({
  baseUrl: process.env.JUNO_COORDINATOR_URL,
  authToken: process.env.JUNO_COORDINATOR_TOKEN,
  network: "mainnet",
});

const signed = await coordinator.createRawTransaction({
  idempotencyKey: "withdrawal-1842-attempt-1",
  walletId: "hot-wallet-1",
  approvalReference: "withdrawal:1842",
  toAddress: withdrawal.address,
  amountZat: withdrawal.amountZat,
});

await withdrawals.save({
  attemptId: signed.attemptId,
  txid: signed.txid,
  rawTxHex: signed.rawTxHex,
  feeZat: signed.feeZat,
  expiryHeight: signed.expiryHeight,
  planDigest: signed.planDigest,
});
```

`rawTxHex` is the ergonomic name for the API field `raw_tx_hex`. It is signed and ready for broadcast.

Use `walletId`, not `addressFrom`. A shielded spend consumes notes owned by a registered wallet/UFVK; it cannot reliably spend “from” one visible address. The private coordinator selects eligible notes, reserves them, applies policy, builds the transaction, and invokes the protected signer.

Amounts are zatoshis. Pass a canonical decimal string or `bigint`; JavaScript `number` is rejected to avoid rounding. A withdrawal can include a lowercase hex memo with at most 512 bytes.

## Broadcast

Creating and broadcasting are separate operations so the exchange can persist and approve the signed result before network submission.

```js
import { GatewayClient } from "@junocash-tools/exchange-sdk";

const gateway = new GatewayClient({
  baseUrl: process.env.JUNO_GATEWAY_URL,
  authToken: process.env.JUNO_GATEWAY_TOKEN,
});

const broadcast = await gateway.broadcast({
  idempotencyKey: "withdrawal-1842-broadcast-1",
  walletId: "hot-wallet-1",
  rawTxHex: signed.rawTxHex,
  expectedTxid: signed.txid,
});
```

Persist the signed result before broadcasting. Verify the saved `planDigest`, fee, expiry height, destination mapping, and approval reference against the approved withdrawal. Reuse the same broadcast idempotency key for an uncertain retry.

Track the result through the existing gateway:

```js
const lookup = await gateway.lookupTransaction(signed.txid, {
  walletId: "hot-wallet-1",
});
```

## Manual attempt control

Use the lower-level methods when the exchange runs polling in its own job system:

```js
const attempt = await coordinator.createAttempt({
  idempotencyKey: "batch-2026-07-27-attempt-1",
  walletId: "hot-wallet-1",
  approvalReference: "batch:2026-07-27",
  outputs: [
    { toAddress: first.address, amountZat: first.amountZat },
    { toAddress: second.address, amountZat: second.amountZat, memoHex: "6869" },
  ],
});

const current = await coordinator.status(attempt.attemptId);
const cancelled = await coordinator.cancelAttempt(attempt.attemptId);
```

`createRawTransaction` calls `createAttempt`, then polls `status` until `signed`. Its default wait is 10 minutes with one-second polling. A local wait timeout does not cancel the server-side attempt. Store `attemptId` and query it again. Cancel explicitly only when exchange policy requires it.

Common states are `planning`, `reserved`, `signing`, `signing_unknown`, `signed`, `broadcast`, `mined`, `final`, `failed_unsigned`, `expired_pending_reconciliation`, `orphaned`, `released`, and `cancelled`. The client keeps polling through `signing_unknown`; if the local wait times out, query the same attempt later and never create a replacement spend until the coordinator resolves it.

## Idempotency and retries

- Use one stable creation key for one immutable withdrawal attempt. Changing the destination, amount, memo, wallet, or approval reference requires a new key.
- `createAttempt` safely retries transient `409`, `429`, `502`, `503`, and `504` responses only when the server marks them retryable. Every retry reuses the exact serialized body and key.
- Reads retry transient failures.
- Broadcast retries network/timeouts and the named safe codes `idempotency_in_progress`, `node_rpc_error`, `node_not_ready`, and `rate_limited`. An unspecified HTTP 500 is not retried automatically.
- Cancellation is not retried automatically because its current contract has no idempotency key.
- Pass an `AbortSignal` and per-request `timeoutMs` for shutdown and bounded work.

## Errors

```js
import { isExchangeSdkError } from "@junocash-tools/exchange-sdk";

try {
  await coordinator.status(attemptId);
} catch (error) {
  if (isExchangeSdkError(error)) {
    console.error({
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      requestId: error.requestId,
      details: error.details,
    });
  }
}
```

Errors retain the API status, stable code, retry flag, request ID, and structured details. They never expose an authorization token or raw response body.

## Authentication and logging

Use separate scoped bearer credentials for the private coordinator and gateway. `authToken` may be a string or an async token provider. Do not expose the coordinator to the public internet or place signing material in the exchange application.

An optional `logger` receives metadata-only completion and retry events. URLs, headers, bodies, wallet IDs, addresses, transaction IDs, raw transaction hex, and credentials are omitted. Logger failures do not affect a transaction request.

## Networks

Set `network` to `mainnet`, `testnet`, or `regtest` on the coordinator client. The SDK verifies the destination’s Juno Bech32m checksum and rejects a different network before making a request. Point each client at services configured for the same network. Never share idempotency records, wallets, credentials, or databases between networks.

## CommonJS

```js
const { CoordinatorClient, GatewayClient } = require("@junocash-tools/exchange-sdk");
```

## Runnable example

```sh
export JUNO_COORDINATOR_URL=https://coordinator.internal.example
export JUNO_COORDINATOR_TOKEN=replace-with-scoped-token
export JUNO_NETWORK=regtest
export JUNO_WALLET_ID=hot-wallet-1
export JUNO_IDEMPOTENCY_KEY=withdrawal-1842-attempt-1

node examples/create-raw-transaction.mjs \
  withdrawal:1842 \
  '<valid-juno-address>' \
  250000
```

The example writes one JSON object containing the signed hex and reconciliation metadata. Redirect it only to an access-controlled location.

## Development

```sh
npm install
npm test
```

`npm test` builds ESM, CommonJS, and declarations; runs mocked contract tests; packs the npm archive; installs it into a temporary consumer; and verifies ESM, CommonJS, and TypeScript consumption. npm publication requests registry provenance through `publishConfig.provenance`.
