/** Base class for every error thrown by this package. */
export declare class LaunchablesError extends Error {
    readonly status: number | undefined;
    /** Parsed JSON body of the error response, or the raw text. */
    readonly body: unknown;
    constructor(message: string, status?: number, body?: unknown);
    /** The message as sent by the server (without the status suffix). */
    readonly serverMessage: string;
}
/** 401: bad or missing token (also thrown locally when no key is set). */
export declare class AuthenticationError extends LaunchablesError {
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
