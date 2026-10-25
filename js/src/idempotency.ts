import { ValidationError } from "./errors.js";

/** The header that identifies one logical request across its retries. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** A new random key (a version 4 UUID). */
async function randomKey(): Promise<string> {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  const { randomUUID } = await import("node:crypto"); // Node 18 without the global Web Crypto
  return randomUUID();
}

/**
 * The Idempotency-Key header for one logical request: the caller's key, checked, or a new random UUID. The same header
 * is sent on every retry of that request, so the server answers it (and bills it) once.
 */
export async function idempotencyHeaders(idempotencyKey?: string): Promise<Record<string, string>> {
  if (idempotencyKey === undefined) return { [IDEMPOTENCY_HEADER]: await randomKey() };
  if (typeof idempotencyKey !== "string" || !/^[\x20-\x7e]{1,255}$/.test(idempotencyKey)) {
    throw new ValidationError("idempotencyKey must be 1 to 255 printable ASCII characters");
  }
  return { [IDEMPOTENCY_HEADER]: idempotencyKey };
}
