export type ZatoshiAmount = string | bigint;
export type JunoNetwork = "mainnet" | "testnet" | "regtest";

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PollOptions extends RequestOptions {
  readonly pollIntervalMs?: number;
  readonly waitTimeoutMs?: number;
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface SdkLogEvent {
  readonly level: "debug" | "warn";
  readonly event: "request_retry" | "request_complete";
  readonly operation: string;
  readonly attempt: number;
  readonly status?: number;
  readonly code?: string;
  readonly delayMs?: number;
}

export type SdkLogger = (event: Readonly<SdkLogEvent>) => void;
export type AuthTokenProvider = () => string | Promise<string>;

export interface ClientOptions {
  readonly baseUrl: string;
  /** Restricts destination addresses to this network when set. */
  readonly network?: JunoNetwork;
  readonly authToken?: string | AuthTokenProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly defaultTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly retry?: RetryOptions;
  /**
   * Receives metadata-only events. Request and response bodies, URLs,
   * addresses, transaction IDs, raw transaction hex, and credentials are
   * never included.
   */
  readonly logger?: SdkLogger;
}

export interface ExchangeClientOptions {
  readonly coordinator: ClientOptions;
  readonly gateway: ClientOptions;
}
