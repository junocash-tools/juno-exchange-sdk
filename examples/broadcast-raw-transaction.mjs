import { readFile } from "node:fs/promises";

import { GatewayClient, isExchangeSdkError } from "@junocash-tools/exchange-sdk";

const [signedTransactionPath] = process.argv.slice(2);
if (!signedTransactionPath) {
  console.error("Usage: node examples/broadcast-raw-transaction.mjs <signed-transaction.json>");
  process.exitCode = 2;
} else {
  const gateway = new GatewayClient({
    baseUrl: requiredEnvironment("JUNO_GATEWAY_URL"),
    authToken: requiredEnvironment("JUNO_GATEWAY_TOKEN"),
  });

  try {
    const signed = JSON.parse(await readFile(signedTransactionPath, "utf8"));
    const result = await gateway.broadcast({
      idempotencyKey: requiredEnvironment("JUNO_BROADCAST_IDEMPOTENCY_KEY"),
      walletId: requiredEnvironment("JUNO_WALLET_ID"),
      rawTxHex: signed.rawTxHex,
      expectedTxid: signed.txid,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
      console.error("Unexpected broadcast failure");
    }
    process.exitCode = 1;
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
