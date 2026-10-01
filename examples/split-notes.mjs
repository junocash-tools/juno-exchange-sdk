import { JunoExchangeClient, isExchangeSdkError } from "@junocash-tools/exchange-sdk";

const [splitId, noteCount, noteZat] = process.argv.slice(2);
if (!splitId || !noteCount || !noteZat) {
  console.error("Usage: node examples/split-notes.mjs <split-id> <note-count> <note-zat>");
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
  const input = {
    splitId,
    walletId: requiredEnvironment("JUNO_WALLET_ID"),
    noteCount: Number(noteCount),
    noteZat,
  };

  try {
    // advanceNoteSplit is one bounded step. Repeat it until the split has been
    // broadcast or has stopped; a real worker would run it from its job system.
    const deadline = Date.now() + 2 * 60_000;
    let status = await exchange.advanceNoteSplit(input);
    while ((status.state === "accepted" || status.state === "signing") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      status = await exchange.advanceNoteSplit(input);
    }
    process.stdout.write(`${JSON.stringify(status)}\n`);
    // Anything short of broadcast, including a wait that ran out, is a failure.
    if (!["broadcast", "mined", "confirmed"].includes(status.state)) process.exitCode = 1;
  } catch (error) {
    if (isExchangeSdkError(error)) {
      console.error(JSON.stringify({
        code: error.code, message: error.message, retryable: error.retryable,
        status: error.status, requestId: error.requestId, details: error.details,
      }));
    } else {
      console.error("Unexpected note split failure");
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
