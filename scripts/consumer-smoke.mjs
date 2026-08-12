import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "juno-exchange-sdk-"));

try {
  const packDirectory = path.join(temporaryRoot, "package");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  await mkdir(packDirectory);
  const packResult = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", packDirectory], root),
  );
  const archive = path.join(packDirectory, packResult[0].filename);
  await mkdir(consumerDirectory);
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@junocash-tools/exchange-sdk": `file:${archive}` },
    }),
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
    consumerDirectory,
  );

  await writeFile(
    path.join(consumerDirectory, "esm.mjs"),
    `import { CoordinatorClient, GatewayClient, JunoExchangeClient } from "@junocash-tools/exchange-sdk";
const coordinator = new CoordinatorClient({ baseUrl: "https://coordinator.example", network: "regtest" });
const gateway = new GatewayClient({ baseUrl: "https://gateway.example" });
const combined = new JunoExchangeClient({ coordinator: { baseUrl: "https://coordinator.example" }, gateway: { baseUrl: "https://gateway.example" } });
if (!coordinator || !gateway || !combined || typeof gateway.getWalletBalance !== "function") throw new Error("ESM exports unavailable");
`,
  );
  await writeFile(
    path.join(consumerDirectory, "commonjs.cjs"),
    `const { CoordinatorClient, GatewayClient, JunoExchangeClient } = require("@junocash-tools/exchange-sdk");
const coordinator = new CoordinatorClient({ baseUrl: "https://coordinator.example", network: "mainnet" });
const gateway = new GatewayClient({ baseUrl: "https://gateway.example" });
const combined = new JunoExchangeClient({ coordinator: { baseUrl: "https://coordinator.example" }, gateway: { baseUrl: "https://gateway.example" } });
if (!coordinator || !gateway || !combined || typeof gateway.getWalletBalance !== "function") throw new Error("CommonJS exports unavailable");
`,
  );
  await writeFile(
    path.join(consumerDirectory, "consumer.ts"),
    `import { CoordinatorClient, GatewayClient, type GatewayPaths, type GetWalletBalanceOptions, type JunoNetwork, type WalletBalanceResult, type ZatoshiAmount } from "@junocash-tools/exchange-sdk";
const network: JunoNetwork = "testnet";
const amount: ZatoshiAmount = 250000n;
const client = new CoordinatorClient({ baseUrl: "https://coordinator.example", network });
const gateway = new GatewayClient({ baseUrl: "https://gateway.example" });
const legacyGatewayPaths: GatewayPaths = { broadcast: "/broadcast", transaction: (txid) => "/transactions/" + txid };
const gatewayWithCustomPaths = new GatewayClient({ baseUrl: "https://gateway.example", paths: legacyGatewayPaths });
const balanceOptions: GetWalletBalanceOptions = { minConfirmations: 100, minNoteZat: 100001n };
const balance: Promise<WalletBalanceResult> = gateway.getWalletBalance("hot-wallet-1", balanceOptions);
void amount;
void client;
void balance;
void gatewayWithCustomPaths;
`,
  );

  run(process.execPath, ["esm.mjs"], consumerDirectory);
  run(process.execPath, ["commonjs.cjs"], consumerDirectory);
  run(
    process.execPath,
    [
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      "--strict",
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.ts",
    ],
    consumerDirectory,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} failed with status ${result.status}\n${output}`);
  }
  return result.stdout;
}
