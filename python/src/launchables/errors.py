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
    if status == 409:
        return ConflictError(message, status, body)
    if status == 429:
        return RateLimitError(message, status, body, retry_after)
    if 400 <= status < 500:
        return InvalidRequestError(message, status, body)
    return APIError(message, status, body)
