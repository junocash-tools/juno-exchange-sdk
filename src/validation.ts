import { ExchangeSdkError } from "./errors.js";
import type { JunoNetwork, ZatoshiAmount } from "./types.js";

const walletIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const attemptIdPattern = /^txn_[0-9a-f]{32}$/;
const lowerHex64Pattern = /^[0-9a-f]{64}$/;
const canonicalPositiveIntegerPattern = /^[1-9][0-9]*$/;
const canonicalUnsignedIntegerPattern = /^(0|[1-9][0-9]*)$/;
const maximumZatoshiValue = 18_446_744_073_709_551_615n;
const maximumSignedZatoshiValue = 9_223_372_036_854_775_807n;
const bech32mCharset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const bech32mValues = new Map([...bech32mCharset].map((character, index) => [character, index]));
const bech32mConstant = 0x2bc830a3;
const addressNetworks = new Map<string, JunoNetwork>([
  ["j", "mainnet"],
  ["jtest", "testnet"],
  ["jregtest", "regtest"],
]);

export function invalidArgument(message: string): ExchangeSdkError {
  return new ExchangeSdkError(message, {
    code: "invalid_argument",
    retryable: false,
  });
}

export function validateBaseUrl(value: string): URL {
  if (typeof value !== "string") {
    throw invalidArgument("baseUrl must be an absolute HTTP or HTTPS URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidArgument("baseUrl must be an absolute HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidArgument("baseUrl must use HTTP or HTTPS");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalidArgument("baseUrl must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw invalidArgument("baseUrl must not contain a query or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
}

export function validateNetwork(value: unknown): JunoNetwork | undefined {
  if (value === undefined) return undefined;
  if (value !== "mainnet" && value !== "testnet" && value !== "regtest") {
    throw invalidArgument("network must be mainnet, testnet, or regtest");
  }
  return value;
}

export function validateWalletId(value: unknown): string {
  if (typeof value !== "string") throw invalidArgument("walletId is invalid");
  const result = value.trim();
  if (!walletIdPattern.test(result)) {
    throw invalidArgument("walletId is invalid");
  }
  return result;
}

export function validateAttemptId(value: unknown): string {
  if (typeof value !== "string") throw invalidArgument("attemptId is invalid");
  const result = value.trim();
  if (!attemptIdPattern.test(result)) {
    throw invalidArgument("attemptId is invalid");
  }
  return result;
}

export function validateResponseAttemptId(value: unknown): string {
  if (typeof value !== "string" || !attemptIdPattern.test(value)) {
    throw invalidResponse("attempt_id must match txn_ followed by 32 lowercase hexadecimal characters");
  }
  return value;
}

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") throw invalidArgument("idempotencyKey is invalid");
  const result = value.trim();
  if (!idempotencyKeyPattern.test(result)) {
    throw invalidArgument("idempotencyKey is invalid");
  }
  return result;
}

export function validateApprovalReference(value: unknown): string {
  if (typeof value !== "string") throw invalidArgument("approvalReference is invalid");
  const result = value.trim();
  if (result === "" || new TextEncoder().encode(result).byteLength > 128) {
    throw invalidArgument("approvalReference is invalid");
  }
  return result;
}

export function validateRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidArgument("requestId is invalid");
  const result = value.trim();
  if (!requestIdPattern.test(result)) {
    throw invalidArgument("requestId is invalid");
  }
  return result;
}

export function validateAddress(
  value: unknown,
  field: string,
  expectedNetwork?: JunoNetwork,
): string {
  if (typeof value !== "string" || value !== value.trim() || value.length > 4096) {
    throw invalidArgument(`${field} is not a valid lowercase Juno unified address`);
  }
  const separator = value.lastIndexOf("1");
  const hrp = value.slice(0, separator);
  const network = addressNetworks.get(hrp);
  if (
    value === "" ||
    value !== value.toLowerCase() ||
    separator < 1 ||
    separator + 7 > value.length ||
    network === undefined ||
    !verifyBech32mChecksum(hrp, value.slice(separator + 1))
  ) {
    throw invalidArgument(`${field} is not a valid lowercase Juno unified address`);
  }
  if (expectedNetwork !== undefined && network !== expectedNetwork) {
    throw invalidArgument(`${field} is for ${network}, expected ${expectedNetwork}`);
  }
  return value;
}

export function validateMemoHex(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidArgument("memoHex must be at most 512 bytes of lowercase hexadecimal data");
  }
  const result = value.trim();
  if (result.length > 1024 || result.length % 2 !== 0 || !/^[0-9a-f]*$/.test(result)) {
    throw invalidArgument("memoHex must be at most 512 bytes of lowercase hexadecimal data");
  }
  return result;
}

export function normalizePositiveZatoshi(value: ZatoshiAmount, field = "amountZat"): string {
  if (typeof value !== "string" && typeof value !== "bigint") {
    throw invalidArgument(`${field} must be a positive canonical decimal string or bigint`);
  }
  const result = typeof value === "bigint" ? value.toString(10) : value.trim();
  if (
    !canonicalPositiveIntegerPattern.test(result) ||
    result.length > 20 ||
    BigInt(result) > maximumZatoshiValue
  ) {
    throw invalidArgument(`${field} must be a positive canonical decimal string or bigint`);
  }
  return result;
}

export function normalizeNonNegativeSignedZatoshi(
  value: ZatoshiAmount,
  field = "amountZat",
): string {
  if (typeof value !== "string" && typeof value !== "bigint") {
    throw invalidArgument(`${field} must be a non-negative canonical decimal string or bigint`);
  }
  const result = typeof value === "bigint" ? value.toString(10) : value;
  if (
    !canonicalUnsignedIntegerPattern.test(result) ||
    result.length > 19 ||
    BigInt(result) > maximumSignedZatoshiValue
  ) {
    throw invalidArgument(
      `${field} must be a non-negative canonical decimal string or bigint no greater than ${maximumSignedZatoshiValue}`,
    );
  }
  return result;
}

export function validateResponseZatoshi(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidResponse(`${field} must be a non-negative integer represented without loss`);
    }
    return String(value);
  }
  if (
    typeof value !== "string" ||
    !canonicalUnsignedIntegerPattern.test(value) ||
    value.length > 19 ||
    BigInt(value) > maximumSignedZatoshiValue
  ) {
    throw invalidResponse(`${field} must be a canonical non-negative signed-64-bit zatoshi value`);
  }
  return value;
}

export function validateUnsignedDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !canonicalUnsignedIntegerPattern.test(value)) {
    throw invalidResponse(`${field} must be a canonical unsigned decimal string`);
  }
  return value;
}

export function validateTxid(value: unknown, field = "txid"): string {
  if (typeof value !== "string") {
    throw invalidArgument(`${field} must be 64 lowercase hexadecimal characters`);
  }
  const result = value.trim();
  if (!lowerHex64Pattern.test(result)) {
    throw invalidArgument(`${field} must be 64 lowercase hexadecimal characters`);
  }
  return result;
}

export function validateResponseTxid(value: unknown, field = "txid"): string {
  if (typeof value !== "string" || !lowerHex64Pattern.test(value)) {
    throw invalidResponse(`${field} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

export function validateRawTxHex(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidArgument("rawTxHex must be non-empty, even-length lowercase hexadecimal data");
  }
  const result = value.trim();
  if (
    result.length === 0 ||
    result.length > 8 * 1024 * 1024 ||
    result.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(result)
  ) {
    throw invalidArgument("rawTxHex must be non-empty, even-length lowercase hexadecimal data");
  }
  return result;
}

export function validateResponseRawTxHex(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8 * 1024 * 1024 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    throw invalidResponse("raw_tx_hex is invalid");
  }
  return value;
}

export function encodePathSegment(value: string, field: string): string {
  const result = value.trim();
  if (result === "" || result.length > 128 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw invalidArgument(`${field} is invalid`);
  }
  return encodeURIComponent(result);
}

export function asRecord(value: unknown, field = "response"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidResponse(`${key} must be a non-empty string`);
  }
  return value;
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidResponse(`${key} must be a non-empty string when present`);
  }
  return value;
}

export function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw invalidResponse(`${key} must be a boolean`);
  }
  return value;
}

export function requireNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse(`${key} must be a non-negative safe integer`);
  }
  return value;
}

export function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse(`${key} must be a non-negative safe integer when present`);
  }
  return value;
}

export function invalidResponse(message: string): ExchangeSdkError {
  return new ExchangeSdkError(`Invalid server response: ${message}`, {
    code: "invalid_response",
    retryable: false,
  });
}

function verifyBech32mChecksum(hrp: string, encodedData: string): boolean {
  const values: number[] = [];
  for (const character of encodedData) {
    const value = bech32mValues.get(character);
    if (value === undefined) return false;
    values.push(value);
  }
  return bech32mPolymod([...expandBech32Hrp(hrp), ...values]) === bech32mConstant;
}

function expandBech32Hrp(hrp: string): number[] {
  const result: number[] = [];
  for (const character of hrp) result.push(character.charCodeAt(0) >> 5);
  result.push(0);
  for (const character of hrp) result.push(character.charCodeAt(0) & 31);
  return result;
}

function bech32mPolymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    if ((top & 1) !== 0) checksum ^= 0x3b6a57b2;
    if ((top & 2) !== 0) checksum ^= 0x26508e6d;
    if ((top & 4) !== 0) checksum ^= 0x1ea119fa;
    if ((top & 8) !== 0) checksum ^= 0x3d4233dd;
    if ((top & 16) !== 0) checksum ^= 0x2a1462b3;
  }
  return checksum;
}
