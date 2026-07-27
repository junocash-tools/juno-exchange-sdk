import { asRecord, invalidResponse } from "./validation.js";

export interface SuccessEnvelope {
  readonly data: Record<string, unknown>;
  readonly requestId: string;
}

export function unwrapSuccessEnvelope(payload: unknown): SuccessEnvelope {
  const envelope = asRecord(payload);
  if (envelope.status !== "ok") {
    throw invalidResponse("status must be ok");
  }
  const data = asRecord(envelope.data, "data");
  const requestId = envelope.request_id;
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw invalidResponse("request_id must be a non-empty string");
  }
  return { data, requestId };
}
