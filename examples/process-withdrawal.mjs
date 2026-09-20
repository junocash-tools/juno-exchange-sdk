import { JunoExchangeClient, isExchangeSdkError } from "@junocash-tools/exchange-sdk";

const [withdrawalId, toAddress, amountZat] = process.argv.slice(2);
if (!withdrawalId || !toAddress || !amountZat) {
  console.error("Usage: node examples/process-withdrawal.mjs <withdrawal-id> <to-address> <amount-zat>");
  process.exitCode = 2;
} else {
  const exchange = new JunoExchangeClient({
    coordinator: {
      baseUrl: requiredEnvironment("JUNO_COORDINATOR_URL"),
      authToken: requiredEnvironment("JUNO_COORDINATOR_TOKEN"),
      network: requiredNetwork(process.env.JUNO_NETWORK),
    },
    gateway: {
      baseUrl: requiredEnvironment("JUNO_GATEWAY_URL"),
      authToken: requiredEnvironment("JUNO_GATEWAY_TOKEN"),
    },
  });

  try {
    const result = await exchange.processWithdrawal(
      { withdrawalId, walletId: requiredEnvironment("JUNO_WALLET_ID"), toAddress, amountZat },
      { pollIntervalMs: 1_000, waitTimeoutMs: 2 * 60_000 },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (isExchangeSdkError(error)) {
      console.error(JSON.stringify({
        code: error.code, message: error.message, retryable: error.retryable,
        status: error.status, requestId: error.requestId, details: error.details,
      }));
    } else {
      console.error("Unexpected withdrawal processing failure");
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
