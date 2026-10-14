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
    const t = (body as { type?: unknown } | null | undefined)?.type;
    this.type = typeof t === "string" ? t : null;
    this.serverMessage = message;
  }

  /** The message as sent by the server (without the status suffix). */
  readonly serverMessage: string;
}

/** 401: bad or missing token (also thrown locally when no key is set). */
export class AuthenticationError extends LaunchablesError {}

/**
 * 402: no prepaid credit left (`type` "out_of_credit") or the key's project reached its monthly budget
 * (`type` "budget_exceeded").
 */
export class OutOfCreditError extends LaunchablesError {}

/** 403: the key's project may not use this model (`type` "model_not_allowed"). */
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

/** 400, 411, 413, 422 (and any other 4xx): the request cannot be answered. */
export class InvalidRequestError extends LaunchablesError {}

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
  if (status === 429) return new RateLimitError(message, status, body, retryAfter);
  if (status >= 400 && status < 500) return new InvalidRequestError(message, status, body);
  return new APIError(message, status, body);
}
