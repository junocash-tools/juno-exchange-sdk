import { GatewayClient, isExchangeSdkError } from "@junocash-tools/exchange-sdk";

const gateway = new GatewayClient({
  baseUrl: requiredEnvironment("JUNO_GATEWAY_URL"),
  authToken: requiredEnvironment("JUNO_GATEWAY_TOKEN"),
});

try {
  const result = await gateway.getWalletBalance(requiredEnvironment("JUNO_WALLET_ID"), {
    minConfirmations: optionalConfirmations(process.env.JUNO_MIN_CONFIRMATIONS),
    minNoteZat: process.env.JUNO_MIN_NOTE_ZAT,
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
    console.error("Unexpected wallet balance failure");
  }
  process.exitCode = 1;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalConfirmations(value) {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("JUNO_MIN_CONFIRMATIONS must be a non-negative integer");
  }
  return Number(value);
}
