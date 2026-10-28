"""Exception hierarchy for the Launchables client."""

from __future__ import annotations

from typing import Any, Optional


class LaunchablesError(Exception):
    """Base class for every error raised by this package."""

    def __init__(
        self,
        message: str,
        status: Optional[int] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.body = body
        t = body.get("type") if isinstance(body, dict) else None
        if t is None and isinstance(body, dict) and isinstance(body.get("error"), dict):
            t = body["error"].get("type")  # the key management API's {"error": {"type", "message"}}
        #: The server's error type (e.g. "out_of_credit", "rate_limited"), or None if it sent none.
        self.type: Optional[str] = t if isinstance(t, str) else None

    def __str__(self) -> str:
        if self.status is not None:
            return f"{self.message} (HTTP {self.status})"
        return self.message


class AuthenticationError(LaunchablesError):
    """401: bad or missing token (also raised locally when no key is set)."""


class OutOfCreditError(LaunchablesError):
    """402: no prepaid credit left (``type`` "out_of_credit") or the key's workspace has reached its
    monthly budget (``type`` "budget_exceeded")."""


class PermissionDeniedError(LaunchablesError):
    """403: the key's workspace may not use this model (``type`` "model_not_allowed"), or an admin key's maker is no
    longer an owner."""


class RateLimitError(LaunchablesError):
    """429: rate limit or daily limit reached."""

    def __init__(self, message, status=429, body=None, retry_after=None):
        super().__init__(message, status, body)
        self.retry_after: Optional[float] = retry_after


class InvalidRequestError(LaunchablesError):
    """400, 411, 413, 422 (and any other 4xx): the request cannot be answered.

    For an image, ``type`` says what was wrong: "invalid_assets", "unsupported_image_format", "invalid_image",
    "image_too_large", "image_dimensions", "too_many_images", "unreferenced_asset" or "image_reference_truncated"
    (400), or "invalid_image_budget" (422). The message names the asset."""


class NotFoundError(InvalidRequestError):
    """404: no such key or workspace in your organisation (key management API)."""


class ConflictError(InvalidRequestError):
    """409: the change conflicts with the organisation's state, e.g. its key limit or an archived workspace (key
    management API)."""


class IdempotencyKeyAlreadyUsedError(ConflictError):
    """409 "idempotency_key_already_used": a request with this ``Idempotency-Key`` was already answered. It is not
    retried: the API does not store answers, so it cannot send the original answer again.

    ``request_id`` is the id of the request that was answered (its ``X-Request-Id``), and ``batch_id`` the batch that a
    batch submission created (follow it with ``client.batches.retrieve(batch_id)``). Nothing was billed for this
    repeat. If you lost the answer, send the request again with a new ``idempotency_key`` (or none, for a random one):
    it is then answered, and billed, as a new request."""

    def __init__(self, message, status=409, body=None):
        request_id = body.get("request_id") if isinstance(body, dict) else None
        batch_id = body.get("batch_id") if isinstance(body, dict) else None
        #: The id of the request that was answered, or None if the server did not say.
        self.request_id: Optional[str] = request_id if isinstance(request_id, str) else None
        #: For a batch submission, the id of the batch it created; otherwise None.
        self.batch_id: Optional[str] = batch_id if isinstance(batch_id, str) else None
        if self.batch_id:
            hint = (f"this batch was already submitted as {self.batch_id}; follow it with "
                    f"client.batches.retrieve({self.batch_id!r})")
        else:
            hint = ("this request was already answered"
                    + (f" (request id {self.request_id})" if self.request_id else "")
                    + ". The answer is not stored, so it cannot be sent again; if you lost it, send the request again "
                    "with a new idempotency_key (it will be answered and billed again)")
        super().__init__(hint, status, body)
        #: The message as the server sent it.
        self.server_message: str = message


class BatchResultsDeletedError(InvalidRequestError):
    """410 "batch_results_deleted": the batch's results are gone. Results are kept for one download: they are deleted
    as soon as they have been sent in full, and results never downloaded are deleted 24 hours after the batch finished.
    Save the results when you first download them. ``results_deleted_at`` says when they were deleted."""

    def __init__(self, message, status=410, body=None):
        at = body.get("results_deleted_at") if isinstance(body, dict) else None
        #: When the results were deleted (ISO 8601), or None if the server did not say.
        self.results_deleted_at: Optional[str] = at if isinstance(at, str) else None
        super().__init__(
            "this batch's results were deleted: results are kept for one download (deleted once sent in full) or, if "
            "never downloaded, for 24 hours after the batch finished", status, body)
        #: The message as the server sent it.
        self.server_message: str = message


class ValidationError(InvalidRequestError, ValueError):
    """Raised locally, before any request is sent, for malformed input."""


class APIError(LaunchablesError):
    """5xx: the server failed (502 model did not respond, 503 maintenance)."""


class APIConnectionError(LaunchablesError):
    """The server could not be reached (DNS, refused, reset, timeout)."""


def error_for_status(status, message, body=None, retry_after=None) -> LaunchablesError:
    if status == 401:
        return AuthenticationError(message, status, body)
    if status == 402:
        return OutOfCreditError(message, status, body)
    if status == 403:
        return PermissionDeniedError(message, status, body)
    if status == 404:
        return NotFoundError(message, status, body)
    t = body.get("type") if isinstance(body, dict) else None
    if status == 409 and t == "idempotency_key_already_used":
        return IdempotencyKeyAlreadyUsedError(message, status, body)
    if status == 409:
        return ConflictError(message, status, body)
    if status == 410 and t == "batch_results_deleted":
        return BatchResultsDeletedError(message, status, body)
    if status == 429:
        return RateLimitError(message, status, body, retry_after)
    if 400 <= status < 500:
        return InvalidRequestError(message, status, body)
    return APIError(message, status, body)
