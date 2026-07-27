import { CoordinatorClient } from "./coordinator.js";
import { GatewayClient } from "./gateway.js";
import type { ExchangeClientOptions } from "./types.js";

export class JunoExchangeClient {
  readonly coordinator: CoordinatorClient;
  readonly gateway: GatewayClient;

  constructor(options: ExchangeClientOptions) {
    this.coordinator = new CoordinatorClient(options.coordinator);
    this.gateway = new GatewayClient(options.gateway);
  }
}
