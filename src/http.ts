import { ExchangeSdkError, errorFromResponse, isExchangeSdkError } from "./errors.js";
import type { AuthTokenProvider, ClientOptions, RetryOptions, SdkLogEvent } from "./types.js";
import {
  invalidArgument,
  validateBaseUrl,
  validateIdempotencyKey,
  validateNetwork,
  validateRequestId,
} from "./validation.js";

export type RetryMode = "none" | "read" | "idempotent_mutation" | "broadcast";

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly operation: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly retryMode: RetryMode;
  /** JSON integer fields that must be decoded as exact decimal strings. */
  readonly losslessIntegerKeys?: readonly string[];
}

const defaults = Object.freeze({
  timeoutMs: 30_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
});
const maxTimerMs = 2_147_483_647;

interface NormalizedRetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export class HttpClient {
  readonly #baseUrl: URL;
  readonly #authToken: string | AuthTokenProvider | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #defaultTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #retry: NormalizedRetryOptions;
  readonly #logger: ClientOptions["logger"];

  constructor(options: ClientOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    validateNetwork(options.network);
    this.#authToken = options.authToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw invalidArgument("a Fetch API implementation is required");
    }
    this.#defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? defaults.timeoutMs,
      "defaultTimeoutMs",
    );
    this.#maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? defaults.maxResponseBytes,
      "maxResponseBytes",
    );
    this.#retry = normalizeRetry(options.retry);
    this.#logger = options.logger;
  }

  async request(request: HttpRequest): Promise<unknown> {
    if (!request.path.startsWith("/") || request.path.startsWith("//")) {
      throw invalidArgument("request path must start with one slash");
    }
    const timeoutMs = boundedTimer(positiveInteger(request.timeoutMs ?? this.#defaultTimeoutMs, "timeoutMs"), "timeoutMs");
    const idempotencyKey =
      request.idempotencyKey === undefined
        ? undefined
        : validateIdempotencyKey(request.idempotencyKey);
    const requestId = validateRequestId(request.requestId);
    const serializedBody = request.body === undefined ? undefined : serializeBody(request.body);

    const deadline = Date.now() + timeoutMs;
    let lastError: ExchangeSdkError | undefined;
    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt += 1) {
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw requestTimeoutError(request.operation);
        const payload = await this.#requestOnce(
          request,
          remainingMs,
          serializedBody,
          idempotencyKey,
          requestId,
        );
        this.#log({
          level: "debug",
          event: "request_complete",
          operation: request.operation,
          attempt,
        });
        return payload;
      } catch (cause) {
        const error = normalizeThrownError(cause, request.operation);
        lastError = error;
        if (
          attempt >= this.#retry.maxAttempts ||
          !shouldRetry(error, request.retryMode) ||
          request.signal?.aborted === true
        ) {
          throw error;
        }
        const delayMs = retryDelay(error, attempt, this.#retry);
        this.#log({
          level: "warn",
          event: "request_retry",
          operation: request.operation,
          attempt,
          code: error.code,
          ...(error.status === undefined ? {} : { status: error.status }),
          delayMs,
        });
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw requestTimeoutError(request.operation);
        await abortableDelay(Math.min(delayMs, remainingMs), request.signal, request.operation);
      }
    }
    throw (
      lastError ??
      new ExchangeSdkError("Juno API request failed", {
        code: "internal_client_error",
        retryable: false,
        operation: request.operation,
      })
    );
  }

  async #requestOnce(
    request: HttpRequest,
    timeoutMs: number,
    serializedBody: string | undefined,
    idempotencyKey: string | undefined,
    requestId: string | undefined,
  ): Promise<unknown> {
    if (request.signal?.aborted === true) {
      throw abortedError(request.operation, request.signal.reason);
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = Date.now() + timeoutMs;

    try {
      const headers = new Headers({ Accept: "application/json" });
      if (serializedBody !== undefined) headers.set("Content-Type", "application/json");
      if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
      if (requestId !== undefined) headers.set("X-Request-ID", requestId);
      let token: string | undefined;
      try {
        token = await withDeadline(
          () => resolveAuthToken(this.#authToken, controller.signal),
          deadline,
          request.signal,
          () => {
            timedOut = true;
            controller.abort();
          },
          () => new ExchangeSdkError("Juno API request timed out while resolving authToken", {
            code: "client_timeout", retryable: true, operation: request.operation,
          }),
          () => abortedError(request.operation, request.signal?.reason),
        );
      } catch (cause) {
        if (timedOut) {
          throw new ExchangeSdkError("Juno API request timed out while resolving authToken", {
            code: "client_timeout", retryable: true, operation: request.operation, cause,
          });
        }
        if (isSignalAborted(request.signal)) throw abortedError(request.operation, request.signal?.reason);
        throw cause;
      }
      if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);

      let response: Response;
      try {
        response = await withDeadline(
          () => this.#fetch(joinUrl(this.#baseUrl, request.path), {
            method: request.method,
            headers,
            signal: controller.signal,
            ...(serializedBody === undefined ? {} : { body: serializedBody }),
          }),
          deadline,
          request.signal,
          () => {
            timedOut = true;
            controller.abort();
          },
          () => new ExchangeSdkError("Juno API request timed out", {
            code: "client_timeout", retryable: true, operation: request.operation,
          }),
          () => abortedError(request.operation, request.signal?.reason),
        );
      } catch (cause) {
        if (timedOut) {
          throw new ExchangeSdkError("Juno API request timed out", {
            code: "client_timeout",
            retryable: true,
            operation: request.operation,
            cause,
          });
        }
        if (isSignalAborted(request.signal)) {
          throw abortedError(request.operation, request.signal?.reason);
        }
        throw new ExchangeSdkError("Juno API network request failed", {
          code: "network_error",
          retryable: true,
          operation: request.operation,
          cause,
        });
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      let payload: unknown;
      try {
        payload = await withDeadline(
          () => readJsonResponse(
            response,
            this.#maxResponseBytes,
            request.operation,
            request.losslessIntegerKeys,
          ),
          deadline,
          request.signal,
          () => {
            timedOut = true;
            controller.abort();
          },
          () => new ExchangeSdkError("Juno API response timed out", {
            code: "client_timeout", retryable: true, operation: request.operation,
          }),
          () => abortedError(request.operation, request.signal?.reason),
        );
      } catch (cause) {
        if (isExchangeSdkError(cause)) throw cause;
        if (timedOut) {
          throw new ExchangeSdkError("Juno API response timed out", {
            code: "client_timeout",
            retryable: true,
            operation: request.operation,
            cause,
          });
        }
        if (isSignalAborted(request.signal)) {
          throw abortedError(request.operation, request.signal?.reason);
        }
        throw new ExchangeSdkError("Juno API response could not be read", {
          code: "network_error",
          retryable: true,
          operation: request.operation,
          cause,
        });
      }
      if (!response.ok) {
        throw errorFromResponse(
          response.status,
          payload,
          request.operation,
          retryAfterFromPayload(payload) ?? retryAfterMs,
        );
      }
      return payload;
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  #log(event: SdkLogEvent): void {
    if (this.#logger === undefined) return;
    try {
      this.#logger(Object.freeze({ ...event }));
    } catch {
      // Application logging must not change transaction behavior.
    }
  }
}

async function withDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
  timeoutError: () => ExchangeSdkError,
  abortError: () => ExchangeSdkError,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    onTimeout();
    throw timeoutError();
  }
  let operationPromise: Promise<T>;
  try {
    operationPromise = operation();
  } catch (error) {
    throw error;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onSignal: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (signal !== undefined) {
      onSignal = () => reject(abortError());
      signal.addEventListener("abort", onSignal, { once: true });
    }
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(timeoutError());
    }, remaining);
  });
  try {
    return await Promise.race([operationPromise, aborted, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onSignal !== undefined && signal !== undefined) signal.removeEventListener("abort", onSignal);
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidArgument(`${field} must be a positive safe integer`);
  }
  return value;
}

function boundedTimer(value: number, field: string): number {
  if (value > maxTimerMs) throw invalidArgument(`${field} must not exceed ${maxTimerMs} milliseconds`);
  return value;
}

function requestTimeoutError(operation: string): ExchangeSdkError {
  return new ExchangeSdkError("Juno API request timed out", {
    code: "client_timeout", retryable: true, operation,
  });
}

function normalizeRetry(value: RetryOptions | undefined): NormalizedRetryOptions {
  const maxAttempts = positiveInteger(value?.maxAttempts ?? defaults.maxAttempts, "retry.maxAttempts");
  const baseDelayMs = positiveInteger(value?.baseDelayMs ?? defaults.baseDelayMs, "retry.baseDelayMs");
  const maxDelayMs = positiveInteger(value?.maxDelayMs ?? defaults.maxDelayMs, "retry.maxDelayMs");
  if (baseDelayMs > maxDelayMs) {
    throw invalidArgument("retry.baseDelayMs must not exceed retry.maxDelayMs");
  }
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

function serializeBody(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (cause) {
    throw new ExchangeSdkError("Request body is not JSON serializable", {
      code: "invalid_argument",
      retryable: false,
      cause,
    });
  }
}

function joinUrl(base: URL, path: string): string {
  return `${base.toString().replace(/\/$/, "")}${path}`;
}

async function resolveAuthToken(
  tokenOrProvider: string | AuthTokenProvider | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (tokenOrProvider === undefined) return undefined;
  const value = typeof tokenOrProvider === "function"
    ? await new Promise<string>((resolve, reject) => {
      const onAbort = (): void => reject(new Error("authToken resolution aborted"));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => tokenOrProvider()).then(
        (token) => { signal.removeEventListener("abort", onAbort); resolve(token); },
        (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
      );
    })
    : tokenOrProvider;
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw invalidArgument("authToken must be a non-empty token without whitespace or control characters");
  }
  return value;
}

async function readJsonResponse(
  response: Response,
  maxResponseBytes: number,
  operation: string,
  losslessIntegerKeys: readonly string[] | undefined,
): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxResponseBytes) {
      throw responseTooLarge(response.status, operation);
    }
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
    throw responseTooLarge(response.status, operation);
  }
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(preserveIntegerFields(text, losslessIntegerKeys)) as unknown;
  } catch (cause) {
    throw new ExchangeSdkError("Juno API returned invalid JSON", {
      code: "invalid_response",
      retryable: false,
      status: response.status,
      operation,
      cause,
    });
  }
}

function preserveIntegerFields(text: string, keys: readonly string[] | undefined): string {
  if (keys === undefined || keys.length === 0) return text;
  const selected = new Set(keys);
  let output = "";
  let copiedThrough = 0;
  let index = 0;

  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const stringEnd = jsonStringEnd(text, index);
    if (stringEnd < 0) return text;
    const rawKey = text.slice(index + 1, stringEnd);
    let colon = stringEnd + 1;
    while (isJsonWhitespace(text[colon])) colon += 1;
    if (!rawKey.includes("\\") && selected.has(rawKey) && text[colon] === ":") {
      let valueStart = colon + 1;
      while (isJsonWhitespace(text[valueStart])) valueStart += 1;
      let valueEnd = valueStart;
      if (text[valueEnd] === "-") valueEnd += 1;
      const digitsStart = valueEnd;
      while (isAsciiDigit(text[valueEnd])) valueEnd += 1;
      if (
        valueEnd > digitsStart &&
        (text[valueEnd] === "," ||
          text[valueEnd] === "}" ||
          text[valueEnd] === "]" ||
          isJsonWhitespace(text[valueEnd]) ||
          valueEnd === text.length)
      ) {
        output += `${text.slice(copiedThrough, valueStart)}"${text.slice(valueStart, valueEnd)}"`;
        copiedThrough = valueEnd;
        index = valueEnd;
        continue;
      }
    }
    index = stringEnd + 1;
  }
  return copiedThrough === 0 ? text : output + text.slice(copiedThrough);
}

function jsonStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index;
    }
  }
  return -1;
}

function isAsciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isJsonWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t";
}

function responseTooLarge(status: number, operation: string): ExchangeSdkError {
  return new ExchangeSdkError("Juno API response exceeds the configured size limit", {
    code: "response_too_large",
    retryable: false,
    status,
    operation,
  });
}

function normalizeThrownError(cause: unknown, operation: string): ExchangeSdkError {
  if (isExchangeSdkError(cause)) return cause;
  return new ExchangeSdkError("Juno SDK request failed", {
    code: "internal_client_error",
    retryable: false,
    operation,
    cause,
  });
}

function shouldRetry(error: ExchangeSdkError, mode: RetryMode): boolean {
  if (mode === "none" || error.code === "client_aborted") return false;
  if (error.code === "network_error" || error.code === "client_timeout") return true;

  if (mode === "broadcast") {
    return (
      error.code === "idempotency_in_progress" ||
      error.code === "node_rpc_error" ||
      error.code === "node_not_ready" ||
      error.code === "rate_limited"
    );
  }
  if (mode === "idempotent_mutation") {
    return (
      error.retryable &&
      (error.status === 409 ||
        error.status === 429 ||
        error.status === 502 ||
        error.status === 503 ||
        error.status === 504)
    );
  }
  return (
    error.retryable ||
    (error.code === "http_error" &&
      (error.status === 408 ||
        error.status === 425 ||
        error.status === 429 ||
        error.status === 500 ||
        error.status === 502 ||
        error.status === 503 ||
        error.status === 504))
  );
}

function retryDelay(
  error: ExchangeSdkError,
  attempt: number,
  options: NormalizedRetryOptions,
): number {
  if (error.retryAfterMs !== undefined) {
    return Math.min(options.maxDelayMs, Math.max(0, error.retryAfterMs));
  }
  const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.max(1, Math.floor(Math.random() * cap));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed) * 1000;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function retryAfterFromPayload(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const error = (payload as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const details = (error as Record<string, unknown>).details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const seconds = (details as Record<string, unknown>).retry_after_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.floor(seconds * 1000);
}

function abortedError(operation: string, cause?: unknown): ExchangeSdkError {
  return new ExchangeSdkError("Juno API request was aborted", {
    code: "client_aborted",
    retryable: false,
    operation,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function abortableDelay(
  delayMs: number,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<void> {
  if (signal?.aborted === true) throw abortedError(operation, signal.reason);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortedError(operation, signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
