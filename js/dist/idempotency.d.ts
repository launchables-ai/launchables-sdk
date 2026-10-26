/** The header that identifies one logical request across its retries. */
export declare const IDEMPOTENCY_HEADER = "Idempotency-Key";
/**
 * The Idempotency-Key header for one logical request: the caller's key, checked, or a new random UUID. The same header
 * is sent on every retry of that request, so the server answers it (and bills it) once.
 */
export declare function idempotencyHeaders(idempotencyKey?: string): Promise<Record<string, string>>;
