/** Base class for every error thrown by this package. */
export class LaunchablesError extends Error {
  readonly status: number | undefined;
  /** Parsed JSON body of the error response, or the raw text. */
  readonly body: unknown;
  /** The server's error type (e.g. "out_of_credit", "rate_limited"), or null if it sent none. */
  readonly type: string | null;

  constructor(message: string, status?: number, body?: unknown) {
    super(status === undefined ? message : `${message} (HTTP ${status})`);
    this.name = new.target.name;
    this.status = status;
    this.body = body;
    const b = body as { type?: unknown; error?: { type?: unknown } } | null | undefined;
    const t = b?.type ?? (typeof b?.error === "object" ? b?.error?.type : undefined);
    this.type = typeof t === "string" ? t : null;
    this.serverMessage = message;
  }

  /** The message as sent by the server (without the status suffix). */
  readonly serverMessage: string;
}

/** 401: bad or missing token (also thrown locally when no key is set). */
export class AuthenticationError extends LaunchablesError {}

/**
 * 402: no prepaid credit left (`type` "out_of_credit") or the key's workspace has reached its monthly budget
 * (`type` "budget_exceeded").
 */
export class OutOfCreditError extends LaunchablesError {}

/** 403: the key's workspace may not use this model (`type` "model_not_allowed"), or an admin key's maker is no longer an owner. */
export class PermissionDeniedError extends LaunchablesError {}

/** 429: rate limit or daily limit reached. */
export class RateLimitError extends LaunchablesError {
  /** Seconds the server asked us to wait, if it said. */
  readonly retryAfter: number | undefined;
  constructor(message: string, status?: number, body?: unknown, retryAfter?: number) {
    super(message, status, body);
    this.retryAfter = retryAfter;
  }
}

/**
 * 400, 411, 413, 422 (and any other 4xx): the request cannot be answered. For an image, `type` says what was wrong:
 * "invalid_assets", "unsupported_image_format", "invalid_image", "image_too_large", "image_dimensions",
 * "too_many_images", "unreferenced_asset" or "image_reference_truncated" (400), or "invalid_image_budget" (422). The
 * message names the asset.
 */
export class InvalidRequestError extends LaunchablesError {}

/** 404: no such key or workspace in your organisation (key management API). */
export class NotFoundError extends InvalidRequestError {}

/** 409: the change conflicts with the organisation's state, e.g. its key limit or an archived workspace (key management API). */
export class ConflictError extends InvalidRequestError {}

/**
 * 409 "idempotency_key_already_used": a request with this `Idempotency-Key` was already answered. It is not retried: the
 * API does not store answers, so it cannot send the original answer again.
 *
 * `requestId` is the id of the request that was answered (its `X-Request-Id`), and `batchId` the batch that a batch
 * submission created (follow it with `client.batches.retrieve(batchId)`). Nothing was billed for this repeat. If you
 * lost the answer, send the request again with a new `idempotencyKey` (or none, for a random one): it is then answered,
 * and billed, as a new request.
 */
export class IdempotencyKeyAlreadyUsedError extends ConflictError {
  /** The id of the request that was answered, or null if the server did not say. */
  readonly requestId: string | null;
  /** For a batch submission, the id of the batch it created; otherwise null. */
  readonly batchId: string | null;

  constructor(message: string, status: number = 409, body?: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as { request_id?: unknown; batch_id?: unknown };
    const requestId = typeof b.request_id === "string" ? b.request_id : null;
    const batchId = typeof b.batch_id === "string" ? b.batch_id : null;
    super(
      batchId
        ? `this batch was already submitted as ${batchId}; follow it with client.batches.retrieve("${batchId}")`
        : `this request was already answered${requestId ? ` (request id ${requestId})` : ""}. The answer is not stored, ` +
            "so it cannot be sent again; if you lost it, send the request again with a new idempotencyKey (it will be " +
            "answered and billed again)",
      status,
      body,
    );
    this.requestId = requestId;
    this.batchId = batchId;
    (this as { serverMessage: string }).serverMessage = message; // the guidance above is the message
  }
}

/**
 * 410 "batch_results_deleted": the batch's results are gone. Results are kept for one download: they are deleted as soon
 * as they have been sent in full, and results never downloaded are deleted 24 hours after the batch finished. Save the
 * results when you first download them. `resultsDeletedAt` says when they were deleted.
 */
export class BatchResultsDeletedError extends InvalidRequestError {
  /** When the results were deleted (ISO 8601), or null if the server did not say. */
  readonly resultsDeletedAt: string | null;

  constructor(message: string, status: number = 410, body?: unknown) {
    super(
      "this batch's results were deleted: results are kept for one download (deleted once sent in full) or, if never " +
        "downloaded, for 24 hours after the batch finished",
      status,
      body,
    );
    const at = (typeof body === "object" && body !== null ? body : {}) as { results_deleted_at?: unknown };
    this.resultsDeletedAt = typeof at.results_deleted_at === "string" ? at.results_deleted_at : null;
    (this as { serverMessage: string }).serverMessage = message; // the guidance above is the message
  }
}

/** Thrown locally, before any request is sent, for malformed input. */
export class ValidationError extends InvalidRequestError {}

/** 5xx: the server failed (502 model did not respond, 503 maintenance). */
export class APIError extends LaunchablesError {}

/** The server could not be reached (DNS, refused, reset, timeout). */
export class APIConnectionError extends LaunchablesError {}

export function errorForStatus(
  status: number,
  message: string,
  body?: unknown,
  retryAfter?: number,
): LaunchablesError {
  if (status === 401) return new AuthenticationError(message, status, body);
  if (status === 402) return new OutOfCreditError(message, status, body);
  if (status === 403) return new PermissionDeniedError(message, status, body);
  if (status === 404) return new NotFoundError(message, status, body);
  const type = typeof body === "object" && body !== null ? (body as { type?: unknown }).type : undefined;
  if (status === 409 && type === "idempotency_key_already_used") return new IdempotencyKeyAlreadyUsedError(message, status, body);
  if (status === 409) return new ConflictError(message, status, body);
  if (status === 410 && type === "batch_results_deleted") return new BatchResultsDeletedError(message, status, body);
  if (status === 429) return new RateLimitError(message, status, body, retryAfter);
  if (status >= 400 && status < 500) return new InvalidRequestError(message, status, body);
  return new APIError(message, status, body);
}
