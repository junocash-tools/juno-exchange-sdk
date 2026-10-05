# Juno Exchange SDK

Typed Node.js access to the private transaction coordinator and public Juno exchange gateway. It lets an exchange request a signed raw transaction, then broadcast and track it without running a CLI command per withdrawal.

The SDK does not hold keys, scan the chain, select notes, calculate fees, or sign locally. Those operations stay behind the private coordinator. The gateway remains a read-and-broadcast boundary.

## Install

```sh
npm install https://github.com/junocash-tools/juno-exchange-sdk/releases/download/v0.4.1/junocash-tools-exchange-sdk-0.4.1.tgz
```

Node.js 20 or later is required. The versioned GitHub Release archive is the supported public distribution. ESM, CommonJS, and TypeScript declarations are included. The package has no runtime dependencies and sends no telemetry.

## Process a withdrawal

```js
import { JunoExchangeClient } from "@junocash-tools/exchange-sdk";

const exchange = new JunoExchangeClient({
  coordinator: {
    baseUrl: process.env.JUNO_COORDINATOR_URL,
    authToken: process.env.JUNO_COORDINATOR_TOKEN,
    network: "mainnet",
  },
  gateway: {
    baseUrl: process.env.JUNO_GATEWAY_URL,
    authToken: process.env.JUNO_GATEWAY_TOKEN,
  },
});

const submitted = await exchange.submitWithdrawal({
  withdrawalId: "1842",
  walletId: "hot-wallet-1",
  toAddress: withdrawal.address,
  amountZat: withdrawal.amountZat,
});

await withdrawals.save({
  withdrawalId: submitted.withdrawalId,
  attemptId: submitted.attemptId,
  state: submitted.state,
});
```

`submitWithdrawal` returns as soon as the coordinator has durably accepted or replayed the withdrawal. It does not wait for signing, broadcast, mining, or finality, so one exchange worker is not blocked by an earlier attempt. Persist both IDs before acknowledging the job. The idempotency namespace belongs to the coordinator and gateway credential principals, so rotate tokens under the same configured principals and do not switch credential names during an uncertain retry.

Run one idempotent progression step from a durable worker:

```js
const status = await exchange.advanceWithdrawal({
  withdrawalId: "1842",
  walletId: "hot-wallet-1",
  toAddress: withdrawal.address,
  amountZat: withdrawal.amountZat,
});
```

The SDK derives the coordinator approval reference plus creation and broadcast idempotency keys from `withdrawalId`. The ID must contain 1–96 ASCII letters, digits, `_`, or `-`, starting with a letter or digit. Reusing an ID with the same immutable request recovers the same attempt and broadcast result. Reusing it with a different wallet, destination, amount, or memo returns an idempotency conflict. Idempotency remains enforced; it is hidden rather than removed.

`advanceWithdrawal` reports an exchange-facing state: `accepted`, `signing`, `ready_to_broadcast`, `broadcast`, `mined`, `confirmed`, `blocked`, or `failed`. The exact coordinator lifecycle remains available as `internalState`, including `orphaned`, `expired_pending_reconciliation`, `released`, and `cancelled`. When exact signed material is ready, it re-reads the expiry-checked attempt and broadcasts it. A successful idempotent replay where the node already knows the tx is also returned as `broadcast`. The high-level helper is a convenience path and broadcasts as soon as the coordinator exposes valid signed material; use the low-level flow below when the exchange must persist and approve the signed result before submission.

Every status object has the same keys. `txid`, `expiryHeight`, and `error` are always present and are `null` when they do not apply yet:

| `state` | `txid` | `expiryHeight` | `error` |
| --- | --- | --- | --- |
| `accepted` | `null` | `null` | `null`, or the last retryable planning error |
| `signing` | `null` | set once notes are reserved | `null`, or the last retryable signer error |
| `ready_to_broadcast` | set | set | `null` |
| `broadcast`, `mined`, `confirmed` | set | set | `null` |
| `blocked` | set when the attempt was signed | set when the attempt was planned | set when the coordinator recorded a cause |
| `failed` | `null` unless the attempt was signed | set when the attempt was planned | set when the coordinator recorded a cause |

`txid` is never `null` from `ready_to_broadcast` onward. A `failed` status is terminal for that `withdrawalId`: calling again with the same ID replays the same failure. When `error.retryable` is `true`, retry the payout with a new `withdrawalId`.

For a simple bounded process-local flow, use `processWithdrawal`. It polls at one second by default, has a strict two-minute total wait, reports each state through `onStatus`, and returns after broadcast rather than waiting for confirmations. A timeout includes the durable attempt ID and latest coordinator state/error when a status was observed; it never cancels or replaces the server attempt. The lower-level HTTP `timeoutMs` is a request-wide deadline, including retries.

Use `walletId`, not `addressFrom`. A shielded spend consumes notes owned by a registered wallet/UFVK; it cannot reliably spend “from” one visible address. The private coordinator selects eligible notes, reserves them, applies policy, builds the transaction, and invokes the protected signer.

Amounts are zatoshis. Pass a canonical decimal string or `bigint`; JavaScript `number` is rejected to avoid rounding. A withdrawal can include a lowercase hex memo with at most 512 bytes.

## Low-level signing and broadcast

Use the low-level clients when the exchange must persist and inspect signed bytes before network submission:

```js
import { CoordinatorClient, GatewayClient } from "@junocash-tools/exchange-sdk";

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

## Wallet-wide balance

Use `getWalletBalance` for one server-calculated view across every address derived for the wallet. The gateway credential needs the `treasury` scope and a grant for the requested wallet.

```js
const balance = await gateway.getWalletBalance("hot-wallet-1", {
  minConfirmations: 100,
  minNoteZat: "0",
});

console.log({
  totalUnspentZat: balance.totalUnspent.valueZat,
  spendableZat: balance.spendable.valueZat,
  pendingSpendZat: balance.pendingSpend.valueZat,
});
```

`totalUnspent` is the wallet-wide total, not one address balance. The five non-overlapping operational buckets—`spendable`, `immature`, `pendingSpend`, `belowMinNote`, and `witnessUnavailable`—partition that total. Each bucket includes `noteCount` and `valueZat`; the spendable and pending buckets also include their relevant extrema and expiry metadata.

All returned zatoshi values are canonical decimal strings and are decoded without JavaScript number rounding. `minNoteZat` accepts a decimal string or `bigint`; JavaScript `number` is rejected. `minConfirmations` must be an integer from `0` through `10000`. Omit either option to use the gateway's configured default. When comparing the result with a future plan, use the same values as `JUNO_GATEWAY_DEFAULT_CONFIRMATIONS` and `JUNO_COORDINATOR_MIN_NOTE_ZAT`; their shipped defaults are `100` and `0`.

Treat `spendable.valueZat` as a liquidity signal, not a withdrawal authorization or reservation. Exact funding still depends on the requested amount, fee, input limit, and active coordinator reservations, so `createRawTransaction` remains authoritative. `spendable` does not subtract notes that active coordinator attempts have already reserved; use `coordinator.getNoteInventory(walletId)` for that view. Save the snapshot height and hash with monitoring records when consistent point-in-time reconciliation matters.

The packaged `examples/get-wallet-balance.mjs` is runnable without application code:

```sh
export JUNO_GATEWAY_URL=https://gateway.example
export JUNO_GATEWAY_TOKEN=replace-with-treasury-token
export JUNO_WALLET_ID=hot-wallet-1
export JUNO_MIN_CONFIRMATIONS=100
export JUNO_MIN_NOTE_ZAT=0

node examples/get-wallet-balance.mjs
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

`createRawTransaction` calls `createAttempt`, then polls `status` until signed material is durable. Its default wait is two minutes with one-second polling and it accepts an `onStatus` callback. An idempotent replay also returns that material if the attempt has already reached `broadcast`, `mined`, `orphaned`, or `final`. It rejects expired or released material because that raw transaction is no longer safe to submit.

A local wait timeout does not cancel the server-side attempt. Store `attemptId` and query it again. Cancel explicitly only when exchange policy requires it.

Common states are `planning`, `reserved`, `signing`, `signing_unknown`, `signed`, `broadcast`, `mined`, `final`, `failed_unsigned`, `expired_pending_reconciliation`, `orphaned`, `released`, and `cancelled`. The client keeps polling through `signing_unknown`; if the local wait times out, query the same attempt later and never create a replacement spend until the coordinator resolves it.

For on-demand diagnostics, `coordinator.listActiveAttempts(walletId)` lists active attempts and note reservations owned by that exact coordinator credential. It never returns signed raw bytes. It is not a preflight call required before each withdrawal; use it only to explain blocked wallet liquidity. `getNoteInventory` covers every credential.

## Note inventory

Orchard notes are spent whole. While an attempt is in flight, every note it selected is reserved, and its change only comes back after the transaction is mined. A hot wallet holding one large note can therefore fund one withdrawal at a time.

`coordinator.getNoteInventory(walletId)` shows what the coordinator can plan with right now:

```js
const inventory = await coordinator.getNoteInventory("hot-wallet-1");
console.log({
  spendable: inventory.spendable.noteCount,
  reserved: inventory.reservedSpendable.noteCount,
  free: inventory.unreservedSpendable.noteCount,
  low: inventory.lowNoteInventory,
});
```

`reservations` lists every active reservation across all coordinator credentials with the owning attempt ID and state. `lowNoteInventory` is true when free notes drop below the coordinator's `JUNO_COORDINATOR_TARGET_NOTES`. It is advisory; alert on it rather than gating withdrawals.

When every eligible note is held by another attempt, the withdrawal fails right away: state `failed`, error code `notes_reserved`, `retryable: true`. The failed attempt holds no notes and never resumes, and calling again with the same `withdrawalId` returns the same failure. Retry with a new `withdrawalId` once a note is released. A wallet that genuinely cannot fund the request fails with `insufficient_balance`, which is not retryable.

With `JUNO_COORDINATOR_TARGET_NOTES` set, the coordinator splits withdrawal change into several notes while the wallet is below target, so inventory recovers without extra work. To fan out funds on demand, run a split:

```js
const split = await exchange.advanceNoteSplit({
  splitId: "fanout-2026-10-01",
  walletId: "hot-wallet-1",
  noteCount: 8,
  noteZat: "25000000",
});
```

Call `advanceNoteSplit` again with the same `splitId` until the state is `broadcast` or later; it uses the same create and broadcast keys each time. The new notes become spendable after the usual confirmations. `coordinator.createNoteSplit` is the low-level equivalent that returns the attempt without broadcasting.

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

Errors retain the API status, stable code, retry flag, request ID, and structured details. Attempt status objects also expose the coordinator's structured `error` when present. They never expose an authorization token or raw response body.

## Authentication and logging

Use separate scoped bearer credentials for the private coordinator and gateway. `authToken` may be a string or an async token provider. Do not expose the coordinator to the public internet or place signing material in the exchange application.

An optional `logger` receives metadata-only completion and retry events. URLs, headers, bodies, wallet IDs, addresses, transaction IDs, raw transaction hex, and credentials are omitted. Logger failures do not affect a transaction request.

## Networks

Set `network` to `mainnet`, `testnet`, or `regtest` on the coordinator client. The SDK verifies the destination’s Juno Bech32m checksum and rejects a different network before making a request. Point each client at services configured for the same network. Never share idempotency records, wallets, credentials, or databases between networks.

## CommonJS

```js
const { CoordinatorClient, GatewayClient, JunoExchangeClient } = require("@junocash-tools/exchange-sdk");
```

## Runnable example

```sh
export JUNO_COORDINATOR_URL=https://coordinator.internal.example
export JUNO_COORDINATOR_TOKEN=replace-with-scoped-token
export JUNO_GATEWAY_URL=https://gateway.example
export JUNO_GATEWAY_TOKEN=replace-with-broadcast-token
export JUNO_NETWORK=regtest
export JUNO_WALLET_ID=hot-wallet-1

node examples/process-withdrawal.mjs \
  1842 \
  '<valid-juno-address>' \
  250000
```

The example writes the public withdrawal result and exits after broadcast. Production workers should call `submitWithdrawal`, persist the returned attempt ID, and invoke `advanceWithdrawal` from their durable job system. The existing raw-create and broadcast examples remain available for the low-level flow.

## Development

```sh
npm install
npm test
```

`npm test` builds ESM, CommonJS, and declarations; runs mocked contract tests; packs the npm archive; installs it into a temporary consumer; and verifies ESM, CommonJS, and TypeScript consumption. npm publication requests registry provenance through `publishConfig.provenance`.
