import { createHmac, timingSafeEqual } from "node:crypto";

export type RawBody = Uint8Array | ArrayBuffer | string;

function bytesOf(body: RawBody): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

function decodeSignature(value: string): Buffer | undefined {
  if (value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    return undefined;
  }

  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 ? decoded : undefined;
}

/**
 * Verify the LINE X-Line-Signature over the exact request bytes. This function
 * does not parse the body. A fixed-size padded comparison keeps the comparison
 * constant-time even when a malformed signature has the wrong decoded length.
 */
export function verifyLineSignature(body: RawBody, signature: string, channelSecret: string): boolean {
  if (channelSecret.length === 0 || typeof signature !== "string") return false;

  const actual = decodeSignature(signature);
  if (!actual) return false;

  const expected = createHmac("sha256", channelSecret).update(bytesOf(body)).digest();
  const candidate = Buffer.alloc(expected.length);
  actual.copy(candidate, 0, 0, Math.min(actual.length, candidate.length));
  const equal = timingSafeEqual(expected, candidate);
  return equal && actual.length === expected.length;
}

export class InvalidLineSignatureError extends Error {
  constructor() {
    super("Invalid LINE signature");
    this.name = "InvalidLineSignatureError";
  }
}

export function assertLineSignature(body: RawBody, signature: string, channelSecret: string): void {
  if (!verifyLineSignature(body, signature, channelSecret)) throw new InvalidLineSignatureError();
}

export const verifySignature = verifyLineSignature;
export const verifyLineWebhookSignature = verifyLineSignature;
