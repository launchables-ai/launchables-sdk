"""The Launchables client (standard library only)."""

from __future__ import annotations

import datetime
import http.client
import json
import os
import socket
import time
import urllib.error
import urllib.request
import warnings
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Union

from ._version import __version__
from .errors import (
    APIConnectionError,
    AuthenticationError,
    LaunchablesError,
    ValidationError,
    error_for_status,
)
from .admin import Admin
from .batches import BatchLine, Batches, CreatedBatch
from .images import Image, validate_assets, validate_image_budget
from .questions import validate_questions
from .responses import DecisionResponse, KeyExpiry, KeyInfo, Model, parse_key_info, parse_response

DEFAULT_BASE_URL = "https://api.launchables.ai"
DEFAULT_ADMIN_BASE_URL = "https://console.launchables.ai"
ENV_API_KEY = "LAUNCHABLES_API_TOKEN"
ENV_ADMIN_KEY = "LAUNCHABLES_ADMIN_KEY"
RETRY_STATUSES = frozenset({429, 502, 503})
BACKOFF_BASE = 0.5
MAX_RETRY_AFTER = 60.0
USER_AGENT = f"launchables-python/{__version__}"
KEY_EXPIRY_WARNING_DAYS = 14  # warn once when a key has this many days or fewer left


class KeyExpiryWarning(UserWarning):
    """Issued once per client when the API key has 14 days or fewer left and no ``on_key_expiry`` callback is set."""


def _days_until(date: str) -> Optional[int]:
    """Whole days from today (UTC) to a YYYY-MM-DD date, or None if it is not one."""
    try:
        end = datetime.date.fromisoformat(date)
    except (TypeError, ValueError):
        return None
    return (end - datetime.datetime.now(datetime.timezone.utc).date()).days

_sleep = time.sleep  # patched in tests


class _DeadlinePassed(Exception):
    """Internal: a request given a deadline ran out of time before it could finish."""


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None  # HTTP-date form is not supported; fall back to backoff
    return max(0.0, seconds)


class Launchables:
    """Client for the Launchables Decision API.

    >>> client = Launchables()  # reads LAUNCHABLES_API_TOKEN
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30,
        max_retries: int = 3,
        on_key_expiry: Optional[Callable[[KeyExpiry], None]] = None,
        admin_key: Optional[str] = None,
        admin_base_url: str = DEFAULT_ADMIN_BASE_URL,
    ) -> None:
        """``on_key_expiry`` is called once per key and expiry date when a response shows the key has 14 days or fewer left, so you can
        rotate it on time; without it, the client issues one ``KeyExpiryWarning`` instead.

        ``admin_key`` (or the ``LAUNCHABLES_ADMIN_KEY`` environment variable) is an admin key, starting
        ``launchables_admin_``, for ``client.admin.keys``. It manages your organisation's API keys and cannot call the
        Decision API."""
        if max_retries < 0:
            raise ValueError("max_retries must be >= 0")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.on_key_expiry = on_key_expiry
        self.key_expiry: Optional[KeyExpiry] = None  # the key's expiry as last seen in a response
        self._warned_for: set = set()  # every key and expiry date warned about: once per pair
        self.admin_key = admin_key
        self.admin_base_url = admin_base_url.rstrip("/")
        #: The key management API: ``admin.keys.list()``, ``create()``, ``roll()`` and ``revoke()``. Needs an admin key.
        self.admin = Admin(self)
        #: The Batch API: ``batches.create()``, ``list()``, ``retrieve()``, ``results()``, ``stream_results()``,
        #: ``cancel()`` and ``wait_for()``.
        self.batches = Batches(self)

    # -- public API --------------------------------------------------------

    def decide(
        self,
        state: Union[str, Mapping[str, Any]],
        questions: Mapping[str, Mapping[str, Any]],
        model: Optional[str] = None,
        *,
        assets: Optional[Mapping[str, Union[Image, Mapping[str, Any]]]] = None,
        image_budget: Optional[int] = None,
    ) -> DecisionResponse:
        """Ask one or more questions about ``state`` (a string or a JSON object).

        Always pass ``model``, a model id from ``models()`` such as ``"myles-g-12b"``, so every request names the model
        that answers it. The API is moving to requiring it; until then a request without one is answered by the server's
        default model, which can change.

        ``assets`` maps a reference to an image (``Image.from_path``, ``Image.from_bytes``, or a dict already in the
        ``{"type": "image", "format", "data_base64"}`` shape). Wherever the reference appears as text in the state (any
        string value), a question's instructions or a criterion's description, the model sees the image there. Option
        labels are not searched. Every asset must be referenced at least once.

        ``image_budget`` (70, 140 or 280) is the most visual tokens one image may use; the server uses 280 when it is
        not given. Lower is cheaper and faster but sees less detail."""
        key = self._resolve_key()
        if not isinstance(state, (str, Mapping)):
            raise ValidationError("state must be a string or a JSON object (dict)")
        body: Dict[str, Any] = {"state": state, "questions": validate_questions(questions)}
        if model is not None:
            body["model"] = model
        if assets is not None:
            body["assets"] = validate_assets(assets)
        if image_budget is not None:
            body["image_budget"] = validate_image_budget(image_budget)
        data = self._request("POST", "/v1/decide", body, key)
        return parse_response(data)

    def batch(self, lines: Sequence[BatchLine], webhook_url: Optional[str] = None) -> CreatedBatch:
        """Submit a batch: many decisions answered within 24 hours at half the live price. The same as
        ``batches.create()``. Each line is a ``decide`` body (a dict) with your ``custom_id`` and its ``model``; follow it
        with ``batches.wait_for(id)`` and ``batches.results(id)``."""
        return self.batches.create(lines, webhook_url=webhook_url)

    def models(self) -> List[Model]:
        # the key is optional here; when there is one, the response also tells the client when it expires
        data = self._request("GET", "/v1/models", key=self.api_key or os.environ.get(ENV_API_KEY))
        return [
            Model(id=m["id"], owned_by=m.get("owned_by", ""), raw=m)
            for m in data.get("data", [])
        ]

    def key(self) -> KeyInfo:
        """Details of the key this client uses: id, name, when it expires and how many days are left, its limits, and
        whether it is paused (and why). It counts as no request and no tokens."""
        return parse_key_info(self._request("GET", "/v1/key", key=self._resolve_key()))

    def health(self) -> Dict[str, Any]:
        """Returns the server's health payload, e.g. ``{"status": "ok"}``."""
        return self._request("GET", "/health")

    # -- internals ---------------------------------------------------------

    def _resolve_key(self) -> str:
        key = self.api_key or os.environ.get(ENV_API_KEY)
        if not key:
            raise AuthenticationError(
                f"No API key. Pass api_key=... or set the {ENV_API_KEY} environment variable."
            )
        return key

    def _resolve_admin_key(self) -> str:
        key = self.admin_key or os.environ.get(ENV_ADMIN_KEY)
        if not key:
            raise AuthenticationError(
                f"No admin key. Pass admin_key=... or set the {ENV_ADMIN_KEY} environment variable. "
                "An owner makes one on the API keys page of the console."
            )
        return key

    @staticmethod
    def _pause(seconds: float) -> None:
        _sleep(seconds)

    def _admin_request(self, method: str, path: str, body: Any = None) -> Dict[str, Any]:
        return self._request(method, path, body, self._resolve_admin_key(), base_url=self.admin_base_url, admin=True)

    def _note_key_headers(self, headers: Any) -> None:
        """Reads the key headers every response to a keyed request carries, and warns once when expiry is close."""
        expires = headers.get("Launchables-Key-Expires") if headers else None
        if not expires:
            return
        days = _days_until(expires)
        if days is None:
            return
        self.key_expiry = KeyExpiry(key_id=headers.get("Launchables-Key-Id"), expires_on=expires, days_left=days)
        which = f"{self.key_expiry.key_id or ''}|{expires}"
        if days > KEY_EXPIRY_WARNING_DAYS or which in self._warned_for:
            return
        self._warned_for.add(which)
        try:
            if self.on_key_expiry is not None:
                self.on_key_expiry(self.key_expiry)
            else:
                warnings.warn(
                    f"Launchables API key {self.key_expiry.key_id or ''} expires on {expires} ({days} day"
                    f"{'' if days == 1 else 's'} left). Roll it in the console to replace it without downtime.",
                    KeyExpiryWarning, stacklevel=4,
                )
        except Exception:  # noqa: BLE001  a failing callback must never break the request it rode on
            pass

    def _request(
        self, method: str, path: str, body: Any = None, key: Optional[str] = None,
        base_url: Optional[str] = None, admin: bool = False,
    ) -> Dict[str, Any]:
        payload = None
        content_type = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            content_type = "application/json"
        # a key management POST (create, roll) is retried only when the server refused it unrun (429), so a retry never
        # makes two keys
        once = (lambda status, _type: status == 429) if admin and method == "POST" else None
        status, raw = self._send(method, path, payload, key, base_url=base_url, admin=admin, content_type=content_type, once=once)
        return self._decode(raw, status)

    def _send(
        self, method: str, path: str, payload: Optional[bytes] = None, key: Optional[str] = None, *,
        base_url: Optional[str] = None, admin: bool = False, content_type: Optional[str] = None,
        accept: str = "application/json", headers: Optional[Mapping[str, str]] = None,
        once: Optional[Callable[[int, Optional[str]], bool]] = None, read: bool = True,
        deadline: Optional[float] = None,
    ) -> Any:
        """Sends one request, retrying as allowed, and returns the first 2xx response.

        With ``read`` (the default) the body is read inside the retry loop and ``(status, bytes)`` is returned; without
        it the open response is returned unread, and the caller must close it. ``once`` marks a request that must never
        run twice: it is retried only on the (status, type) pairs it accepts, and never after a lost connection.
        ``deadline`` (a ``time.monotonic()`` value) caps each attempt's timeout and the waits between attempts; past it,
        ``_DeadlinePassed`` is raised."""
        all_headers = {"User-Agent": USER_AGENT, "Accept": accept}
        if headers:
            all_headers.update(headers)
        if key:
            all_headers["Authorization"] = f"Bearer {key}"
        if payload is not None:
            all_headers["Content-Type"] = content_type or "application/json"
        base_url = self.base_url if base_url is None else base_url  # never the Decision API for an admin call
        url = base_url + path
        note = key and not admin

        def retryable(status: int, type_: Optional[str]) -> bool:
            if type_ == "batch_unavailable":
                return False  # the Batch API is switched off on this server; asking again will not change that
            return once(status, type_) if once is not None else status in RETRY_STATUSES

        attempt = 0
        while True:
            timeout = self.timeout
            if deadline is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise _DeadlinePassed()
                timeout = min(timeout, left)
            req = urllib.request.Request(url, data=payload, headers=all_headers, method=method)
            retry_after: Optional[float] = None
            try:
                resp = urllib.request.urlopen(req, timeout=timeout)
                try:
                    if note:
                        self._note_key_headers(resp.headers)
                    if not read:
                        return resp
                    return resp.status, resp.read()
                finally:
                    if read:
                        resp.close()
            except urllib.error.HTTPError as e:
                try:
                    raw = e.read()
                except (OSError, http.client.HTTPException):
                    raw = b""
                finally:
                    e.close()
                if note:
                    self._note_key_headers(e.headers)
                retry_after = _parse_retry_after(e.headers.get("Retry-After") if e.headers else None)
                err: LaunchablesError = self._http_error(e.code, raw, retry_after)
                ok_to_retry = retryable(e.code, err.type)
            except (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError, http.client.HTTPException) as e:
                reason = getattr(e, "reason", e)
                err = APIConnectionError(f"Could not reach {base_url}: {reason}")
                err.__cause__ = e
                ok_to_retry = once is None
            if not ok_to_retry or attempt >= self.max_retries:
                raise err
            delay = min(retry_after if retry_after is not None else BACKOFF_BASE * (2 ** attempt), MAX_RETRY_AFTER)
            if deadline is not None and time.monotonic() + delay >= deadline:
                raise _DeadlinePassed()
            _sleep(delay)
            attempt += 1

    @staticmethod
    def _decode(raw: bytes, status: int) -> Dict[str, Any]:
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise LaunchablesError("Server returned a non-JSON response", status, raw[:500]) from None
        if not isinstance(data, dict):
            raise LaunchablesError("Server returned an unexpected response", status, data)
        return data

    @staticmethod
    def _http_error(status: int, raw: bytes, retry_after: Optional[float]) -> LaunchablesError:
        message = f"HTTP {status}"
        body: Any = None
        try:
            body = json.loads(raw.decode("utf-8"))
            if isinstance(body, dict) and isinstance(body.get("error"), str):
                message = body["error"]
            # the key management API sends {"error": {"type", "message"}}
            elif isinstance(body, dict) and isinstance(body.get("error"), dict) and isinstance(body["error"].get("message"), str):
                message = body["error"]["message"]
        except (ValueError, UnicodeDecodeError):
            text = raw[:200].decode("utf-8", "replace").strip()
            if text:
                message = text
        return error_for_status(status, message, body, retry_after)
