export interface ExchangeSdkErrorOptions {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  readonly details?: unknown;
  readonly operation?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class ExchangeSdkError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly details: unknown;
  readonly operation: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ExchangeSdkErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExchangeSdkError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details;
    this.operation = options.operation;
    this.retryAfterMs = options.retryAfterMs;
  }
}

interface ErrorEnvelope {
  readonly status?: unknown;
  readonly error?: unknown;
  readonly request_id?: unknown;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function errorFromResponse(
  httpStatus: number,
  payload: unknown,
  operation: string,
  retryAfterMs?: number,
): ExchangeSdkError {
  const envelope = recordOrUndefined(payload) as ErrorEnvelope | undefined;
  const error = recordOrUndefined(envelope?.error);
  const code =
    typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : "http_error";
  const message =
    typeof error?.message === "string" && error.message.trim() !== ""
      ? error.message
      : `Juno API request failed with HTTP ${httpStatus}`;
  const retryable = typeof error?.retryable === "boolean" ? error.retryable : false;
  const requestId =
    typeof envelope?.request_id === "string" && envelope.request_id.trim() !== ""
      ? envelope.request_id
      : undefined;

  return new ExchangeSdkError(message, {
    code,
    retryable,
    status: httpStatus,
    operation,
    ...(requestId === undefined ? {} : { requestId }),
    ...(error?.details === undefined ? {} : { details: error.details }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

export function isExchangeSdkError(value: unknown): value is ExchangeSdkError {
  return value instanceof ExchangeSdkError;
}
