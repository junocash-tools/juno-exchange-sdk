import assert from "node:assert/strict";

export const ATTEMPT_ID = "attempt-1842-1";
export const WALLET_ID = "hot-wallet-1";
export const APPROVAL_REFERENCE = "withdrawal:1842";
export const TXID = "a".repeat(64);
export const PLAN_DIGEST = `sha256:${"b".repeat(64)}`;
export const NOTE_ID = `${"c".repeat(64)}:0`;

export function attempt(overrides = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    wallet_id: WALLET_ID,
    approval_reference: APPROVAL_REFERENCE,
    state: "planning",
    ...overrides,
  };
}

export function signedAttempt(overrides = {}) {
  return attempt({
    state: "signed",
    change_address: junoAddress("regtest"),
    amount_zat: "250000",
    fee_zat: "10000",
    expiry_height: 1_234,
    plan_digest: PLAN_DIGEST,
    selected_note_ids: [NOTE_ID],
    txid: TXID,
    raw_tx_hex: "00aabbcc",
    orchard_output_action_indices: [0],
    orchard_change_action_index: 1,
    ...overrides,
  });
}

export function success(data, requestId = "server-request-1") {
  return { status: "ok", data, request_id: requestId };
}

export function failure({ code, message, retryable, details }, requestId = "server-request-1") {
  return {
    status: "error",
    error: {
      code,
      message,
      retryable,
      ...(details === undefined ? {} : { details }),
    },
    request_id: requestId,
  };
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function scriptedFetch(steps) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const call = {
      url: String(input),
      method: init.method,
      headers: new Headers(init.headers),
      body: init.body,
      signal: init.signal,
    };
    calls.push(call);
    const step = steps.shift();
    assert.notEqual(step, undefined, `unexpected request ${call.method} ${call.url}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(call, calls.length) : step;
  };
  return { fetch, calls };
}

export function requestJson(call) {
  assert.equal(typeof call.body, "string");
  return JSON.parse(call.body);
}

export function junoAddress(network = "regtest") {
  const hrp = { mainnet: "j", testnet: "jtest", regtest: "jregtest" }[network];
  assert.ok(hrp);
  const bytes = Uint8Array.from({ length: 48 }, (_, index) => (index * 17 + 3) & 0xff);
  const data = convertBits(bytes, 8, 5, true);
  const checksum = createChecksum(hrp, data);
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  return `${hrp}1${[...data, ...checksum].map((value) => charset[value]).join("")}`;
}

function createChecksum(hrp, data) {
  const values = [...expandHrp(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 0x2bc830a3;
  return Array.from({ length: 6 }, (_, index) => (mod >>> (5 * (5 - index))) & 31);
}

function expandHrp(hrp) {
  return [
    ...[...hrp].map((character) => character.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((character) => character.charCodeAt(0) & 31),
  ];
}

function polymod(values) {
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

function convertBits(input, fromBits, toBits, pad) {
  let accumulator = 0;
  let bits = 0;
  const result = [];
  const maxValue = (1 << toBits) - 1;
  for (const value of input) {
    accumulator = (accumulator << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >> bits) & maxValue);
    }
  }
  if (pad && bits > 0) result.push((accumulator << (toBits - bits)) & maxValue);
  return result;
}
