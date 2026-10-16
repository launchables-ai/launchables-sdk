/** Base class for every error thrown by this package. */
export class LaunchablesError extends Error {
    status;
    /** Parsed JSON body of the error response, or the raw text. */
    body;
    /** The server's error type (e.g. "out_of_credit", "rate_limited"), or null if it sent none. */
    type;
    constructor(message, status, body) {
        super(status === undefined ? message : `${message} (HTTP ${status})`);
        this.name = new.target.name;
        this.status = status;
        this.body = body;
        const b = body;
        const t = b?.type ?? (typeof b?.error === "object" ? b?.error?.type : undefined);
        this.type = typeof t === "string" ? t : null;
        this.serverMessage = message;
    }
    /** The message as sent by the server (without the status suffix). */
    serverMessage;
}
/** 401: bad or missing token (also thrown locally when no key is set). */
export class AuthenticationError extends LaunchablesError {
}
/**
 * 402: no prepaid credit left (`type` "out_of_credit") or the key's workspace has reached its monthly budget
 * (`type` "budget_exceeded").
 */
export class OutOfCreditError extends LaunchablesError {
}
/** 403: the key's workspace may not use this model (`type` "model_not_allowed"), or an admin key's maker is no longer an owner. */
export class PermissionDeniedError extends LaunchablesError {
}
/** 429: rate limit or daily limit reached. */
export class RateLimitError extends LaunchablesError {
    /** Seconds the server asked us to wait, if it said. */
    retryAfter;
    constructor(message, status, body, retryAfter) {
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
export class InvalidRequestError extends LaunchablesError {
}
/** 404: no such key or workspace in your organisation (key management API). */
export class NotFoundError extends InvalidRequestError {
}
/** 409: the change conflicts with the organisation's state, e.g. its key limit or an archived workspace (key management API). */
export class ConflictError extends InvalidRequestError {
}
/** Thrown locally, before any request is sent, for malformed input. */
export class ValidationError extends InvalidRequestError {
}
/** 5xx: the server failed (502 model did not respond, 503 maintenance). */
export class APIError extends LaunchablesError {
}
/** The server could not be reached (DNS, refused, reset, timeout). */
export class APIConnectionError extends LaunchablesError {
}
export function errorForStatus(status, message, body, retryAfter) {
    if (status === 401)
        return new AuthenticationError(message, status, body);
    if (status === 402)
        return new OutOfCreditError(message, status, body);
    if (status === 403)
        return new PermissionDeniedError(message, status, body);
    if (status === 404)
        return new NotFoundError(message, status, body);
    if (status === 409)
        return new ConflictError(message, status, body);
    if (status === 429)
        return new RateLimitError(message, status, body, retryAfter);
    if (status >= 400 && status < 500)
        return new InvalidRequestError(message, status, body);
    return new APIError(message, status, body);
}
