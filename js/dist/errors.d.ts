/** Base class for every error thrown by this package. */
export declare class LaunchablesError extends Error {
    readonly status: number | undefined;
    /** Parsed JSON body of the error response, or the raw text. */
    readonly body: unknown;
    /** The server's error type (e.g. "out_of_credit", "rate_limited"), or null if it sent none. */
    readonly type: string | null;
    constructor(message: string, status?: number, body?: unknown);
    /** The message as sent by the server (without the status suffix). */
    readonly serverMessage: string;
}
/** 401: bad or missing token (also thrown locally when no key is set). */
export declare class AuthenticationError extends LaunchablesError {
}
/**
 * 402: no prepaid credit left (`type` "out_of_credit") or the key's workspace has reached its monthly budget
 * (`type` "budget_exceeded").
 */
export declare class OutOfCreditError extends LaunchablesError {
}
/** 403: the key's workspace may not use this model (`type` "model_not_allowed"). */
export declare class PermissionDeniedError extends LaunchablesError {
}
/** 429: rate limit or daily limit reached. */
export declare class RateLimitError extends LaunchablesError {
    /** Seconds the server asked us to wait, if it said. */
    readonly retryAfter: number | undefined;
    constructor(message: string, status?: number, body?: unknown, retryAfter?: number);
}
/** 400, 411, 413, 422 (and any other 4xx): the request cannot be answered. */
export declare class InvalidRequestError extends LaunchablesError {
}
/** Thrown locally, before any request is sent, for malformed input. */
export declare class ValidationError extends InvalidRequestError {
}
/** 5xx: the server failed (502 model did not respond, 503 maintenance). */
export declare class APIError extends LaunchablesError {
}
/** The server could not be reached (DNS, refused, reset, timeout). */
export declare class APIConnectionError extends LaunchablesError {
}
export declare function errorForStatus(status: number, message: string, body?: unknown, retryAfter?: number): LaunchablesError;
