import { CoordinatorClient, isExchangeSdkError } from "@junocash-tools/exchange-sdk";

const [approvalReference, toAddress, amountZat] = process.argv.slice(2);
if (!approvalReference || !toAddress || !amountZat) {
  console.error(
    "Usage: node examples/create-raw-transaction.mjs <approval-reference> <to-address> <amount-zat>",
  );
  process.exitCode = 2;
} else {
  const coordinator = new CoordinatorClient({
    baseUrl: requiredEnvironment("JUNO_COORDINATOR_URL"),
    authToken: requiredEnvironment("JUNO_COORDINATOR_TOKEN"),
    network: requiredNetwork(process.env.JUNO_NETWORK),
  });

  try {
    const signed = await coordinator.createRawTransaction(
      {
        idempotencyKey: requiredEnvironment("JUNO_IDEMPOTENCY_KEY"),
        walletId: requiredEnvironment("JUNO_WALLET_ID"),
        approvalReference,
        toAddress,
        amountZat,
      },
      { pollIntervalMs: 1_000, waitTimeoutMs: 10 * 60_000 },
    );
    process.stdout.write(
      `${JSON.stringify({
        attemptId: signed.attemptId,
        txid: signed.txid,
        rawTxHex: signed.rawTxHex,
        feeZat: signed.feeZat,
        expiryHeight: signed.expiryHeight,
        planDigest: signed.planDigest,
        orchardOutputActionIndices: signed.orchardOutputActionIndices,
        orchardChangeActionIndex: signed.orchardChangeActionIndex,
      })}\n`,
    );
  } catch (error) {
    if (isExchangeSdkError(error)) {
      console.error(
        JSON.stringify({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          status: error.status,
          requestId: error.requestId,
        }),
      );
    } else {
      console.error("Unexpected transaction creation failure");
    }
    process.exitCode = 1;
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredNetwork(value) {
  if (value === "mainnet" || value === "testnet" || value === "regtest") return value;
  throw new Error("JUNO_NETWORK must be mainnet, testnet, or regtest");
}
