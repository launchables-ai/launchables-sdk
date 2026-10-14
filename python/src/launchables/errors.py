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
        #: The server's error type (e.g. "out_of_credit", "rate_limited"), or None if it sent none.
        self.type: Optional[str] = t if isinstance(t, str) else None

    def __str__(self) -> str:
        if self.status is not None:
            return f"{self.message} (HTTP {self.status})"
        return self.message


class AuthenticationError(LaunchablesError):
    """401: bad or missing token (also raised locally when no key is set)."""


class OutOfCreditError(LaunchablesError):
    """402: no prepaid credit left (``type`` "out_of_credit") or the key's project reached its
    monthly budget (``type`` "budget_exceeded")."""


class PermissionDeniedError(LaunchablesError):
    """403: the key's project may not use this model (``type`` "model_not_allowed")."""


class RateLimitError(LaunchablesError):
    """429: rate limit or daily limit reached."""

    def __init__(self, message, status=429, body=None, retry_after=None):
        super().__init__(message, status, body)
        self.retry_after: Optional[float] = retry_after


class InvalidRequestError(LaunchablesError):
    """400, 411, 413, 422 (and any other 4xx): the request cannot be answered."""


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
    if status == 429:
        return RateLimitError(message, status, body, retry_after)
    if 400 <= status < 500:
        return InvalidRequestError(message, status, body)
    return APIError(message, status, body)
