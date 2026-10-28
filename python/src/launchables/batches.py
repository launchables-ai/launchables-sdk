"""The Batch API: many decisions in one submission, answered within 24 hours at half the live price."""

from __future__ import annotations

import datetime
import http.client
import json
import math
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterator, List, Literal, Mapping, Optional, Sequence, Union

from .errors import (
    APIConnectionError,
    APIError,
    LaunchablesError,
    RateLimitError,
    ValidationError,
)
from .images import validate_assets, validate_image_budget
from .questions import validate_questions
from .responses import DecisionResponse, parse_response

if TYPE_CHECKING:
    from .client import Launchables

#: A ``custom_id``: 1 to 64 letters, digits or ``_ . : -``, unique in its batch.
CUSTOM_ID_PATTERN = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
#: The statuses after which a batch never changes again.
BATCH_FINISHED_STATUSES = ("done", "failed", "cancelled")
#: How long after a cancel ``wait_for`` waits for the lines in progress before taking the batch as finished anyway.
CANCEL_SETTLE_SECONDS = 600.0
#: ``wait_for``'s defaults, in seconds: the first wait, the longest wait, and the timeout (25 hours, past the 24-hour window).
DEFAULT_POLL_INTERVAL = 5.0
DEFAULT_MAX_INTERVAL = 60.0
DEFAULT_WAIT_TIMEOUT = 25 * 3600.0

_BATCH_ID = re.compile(r"batch_[0-9a-f]{24}")

#: One line of a batch: the body of one ``POST /v1/decide`` request plus your ``custom_id``. Keys are as they are sent:
#: ``custom_id``, ``model`` (required on every line), ``state``, ``questions``, and optionally ``assets`` and ``image_budget``.
BatchLine = Mapping[str, Any]


# -- types ------------------------------------------------------------------


@dataclass(frozen=True)
class BatchCostEstimate:
    """The server's cost estimate for a batch. It is advisory: the bill uses the input tokens actually read, line by line."""

    amount: float = 0.0
    currency: str = ""
    input_tokens: int = 0
    rate: float = 0.0  # the share of the live per-token price a batch pays (0.5)
    basis: str = "estimate"


@dataclass(frozen=True)
class BatchCounts:
    """Lines answered, lines failed (cancelled and expired lines count as failed once the batch ends) and lines still to run."""

    done: int = 0
    failed: int = 0
    pending: int = 0


@dataclass(frozen=True)
class CreatedBatch:
    """What ``create`` returns: the new batch, queued."""

    id: str
    status: str
    lines: int
    estimated_cost: BatchCostEstimate
    expires_at: Optional[str]  # when the 24-hour window ends: lines not answered by then fail as "expired"
    data_region: Optional[str]  # where the batch's files are stored
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class Batch:
    """A batch's status, from ``retrieve``, ``list``, ``cancel`` and ``wait_for``."""

    id: str
    status: str  # "queued", "running", "done", "failed" or "cancelled"
    lines: int
    counts: BatchCounts
    models: List[str]  # the models the batch's lines name
    created_at: Optional[str]
    started_at: Optional[str]
    finished_at: Optional[str]
    expires_at: Optional[str]
    reason: Optional[str]  # why the batch ended early, e.g. "cancelled", "expired" or "key_revoked"
    results_available: bool
    webhook: bool  # whether a webhook address was given (the address itself is never shown)
    estimated_cost: BatchCostEstimate
    data_region: Optional[str]
    delete_after: Optional[str]  # when the batch and its results are deleted at the latest; None while it runs
    results_deleted_at: Optional[str] = None  # when the results were deleted (downloaded once, or 24 hours passed)
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class BatchUsage:
    """Tokens for one line. Batch lines are billed on ``input_tokens`` at the batch rate; unanswered lines are not billed."""

    input_tokens: int = 0
    output_tokens: int = 0
    batch: bool = True


@dataclass(frozen=True)
class AnsweredBatchResult:
    """An answered line: ``response`` is the decision, exactly as ``decide`` would return it."""

    custom_id: Optional[str]
    model: Optional[str]  # the model build that answered
    status: Optional[int]  # the HTTP status the line got (200)
    usage: BatchUsage
    response: DecisionResponse
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)
    error: None = None
    ok: Literal[True] = True


@dataclass(frozen=True)
class FailedBatchResult:
    """A line that was not answered: ``error`` says why, e.g. type "expired", "cancelled" or a refusal such as
    "invalid_question"."""

    custom_id: Optional[str]
    model: Optional[str]  # the model the line named
    status: Optional[int]  # the HTTP status the line got, or None for a line that was never run
    usage: BatchUsage
    error: Dict[str, Any]
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)
    response: None = None
    ok: Literal[False] = False


#: One line of a batch's results, in input order. Check ``ok`` to tell which kind it is.
BatchResult = Union[AnsweredBatchResult, FailedBatchResult]


class BatchTimeoutError(LaunchablesError):
    """``wait_for`` ran out of time. The batch keeps running; ``batch`` is its last status read (None if none was)."""

    def __init__(self, message: str, batch: Optional[Batch]) -> None:
        super().__init__(message)
        self.batch = batch


class BatchWaitCancelledError(LaunchablesError):
    """``wait_for`` stopped because its ``stop`` event was set. The batch itself is not cancelled; ``batch`` is its last
    status read (None if none was)."""

    def __init__(self, message: str, batch: Optional[Batch]) -> None:
        super().__init__(message)
        self.batch = batch


# -- parsing ----------------------------------------------------------------


def _int(v: Any) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _float(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _str(v: Any) -> Optional[str]:
    return v if isinstance(v, str) else None


def _estimate(data: Any) -> BatchCostEstimate:
    d = data if isinstance(data, Mapping) else {}
    return BatchCostEstimate(
        amount=_float(d.get("amount")), currency=str(d.get("currency") or ""), input_tokens=_int(d.get("input_tokens")),
        rate=_float(d.get("rate")), basis=str(d.get("basis") or "estimate"),
    )


def parse_created_batch(data: Dict[str, Any]) -> CreatedBatch:
    return CreatedBatch(
        id=str(data.get("id", "")), status=str(data.get("status", "")), lines=_int(data.get("lines")),
        estimated_cost=_estimate(data.get("estimated_cost")), expires_at=_str(data.get("expires_at")),
        data_region=_str(data.get("data_region")), raw=data,
    )


def parse_batch(data: Dict[str, Any]) -> Batch:
    c = data.get("counts") if isinstance(data.get("counts"), Mapping) else {}
    models = data.get("models")
    return Batch(
        id=str(data.get("id", "")), status=str(data.get("status", "")), lines=_int(data.get("lines")),
        counts=BatchCounts(done=_int(c.get("done")), failed=_int(c.get("failed")), pending=_int(c.get("pending"))),
        models=[m for m in models if isinstance(m, str)] if isinstance(models, list) else [],
        created_at=_str(data.get("created_at")), started_at=_str(data.get("started_at")),
        finished_at=_str(data.get("finished_at")), expires_at=_str(data.get("expires_at")), reason=_str(data.get("reason")),
        results_available=bool(data.get("results_available", False)), webhook=bool(data.get("webhook", False)),
        estimated_cost=_estimate(data.get("estimated_cost")), data_region=_str(data.get("data_region")),
        delete_after=_str(data.get("delete_after")), results_deleted_at=_str(data.get("results_deleted_at")), raw=data,
    )


def parse_result(data: Dict[str, Any]) -> BatchResult:
    """One results line, as sent by the server, typed."""
    u = data.get("usage") if isinstance(data.get("usage"), Mapping) else {}
    status = data.get("status")
    common: Dict[str, Any] = dict(
        custom_id=_str(data.get("custom_id")),
        model=_str(data.get("model")),
        status=status if isinstance(status, int) and not isinstance(status, bool) else None,
        usage=BatchUsage(input_tokens=_int(u.get("input_tokens")), output_tokens=_int(u.get("output_tokens"))),
        raw=data,
    )
    response = data.get("response")
    if isinstance(response, Mapping):
        try:
            return AnsweredBatchResult(response=parse_response(dict(response)), **common)
        except (KeyError, TypeError, ValueError, AttributeError):
            return FailedBatchResult(
                error={"error": "the answer could not be read by this version of the client", "type": "unreadable_answer"},
                **common,
            )
    error = data.get("error")
    if isinstance(error, Mapping):
        return FailedBatchResult(error=dict(error), **common)
    return FailedBatchResult(error={"error": error if isinstance(error, str) else "this line was not answered"}, **common)


# -- checks -----------------------------------------------------------------


def _batch_path(batch_id: Any) -> str:
    if not isinstance(batch_id, str) or not _BATCH_ID.fullmatch(batch_id):
        raise ValidationError(f'not a batch id: {batch_id!r} (ids look like "batch_" and 24 hex digits)')
    return f"/v1/batches/{batch_id}"


def to_jsonl(lines: Sequence[BatchLine]) -> bytes:
    """Checks every line before anything is sent and returns the JSONL body. Raises ``ValidationError`` naming the line."""
    if isinstance(lines, (str, bytes, bytearray, Mapping)) or not isinstance(lines, Sequence) or len(lines) == 0:
        raise ValidationError("a batch needs at least one line (a list of dicts)")
    seen = set()
    out: List[str] = []
    for i, line in enumerate(lines):
        where = f"line {i + 1}"
        if not isinstance(line, Mapping):
            raise ValidationError(f"{where}: must be a dict")
        custom_id = line.get("custom_id")
        if not isinstance(custom_id, str) or not CUSTOM_ID_PATTERN.fullmatch(custom_id):
            raise ValidationError(f"{where}: custom_id must be 1 to 64 letters, digits or _ . : -")
        where += f" (custom_id {custom_id})"
        if custom_id in seen:
            raise ValidationError(f"{where}: custom_id is used on an earlier line")
        seen.add(custom_id)
        model = line.get("model")
        if not isinstance(model, str) or model == "":
            raise ValidationError(f"{where}: every line names its model; a batch has no default model")
        state = line.get("state")
        if not isinstance(state, (str, Mapping)):
            raise ValidationError(f"{where}: state must be a string or a JSON object (dict)")
        body: Dict[str, Any] = dict(line)
        try:
            body["questions"] = validate_questions(line.get("questions"))
            if line.get("assets") is not None:
                assets = validate_assets(line["assets"])
                for ref, image in assets.items():
                    if not isinstance(image.get("data_base64"), str):
                        raise ValidationError(
                            f"asset {ref!r} must be inline (data_base64): a batch line cannot carry file parts"
                        )
                body["assets"] = assets
            else:
                body.pop("assets", None)
            if line.get("image_budget") is not None:
                body["image_budget"] = validate_image_budget(line["image_budget"])
            else:
                body.pop("image_budget", None)
        except ValidationError as e:
            raise ValidationError(f"{where}: {e.message}") from None
        try:
            out.append(json.dumps(body, separators=(",", ":"), allow_nan=False))
        except (TypeError, ValueError) as e:
            raise ValidationError(f"{where}: cannot be sent as JSON ({e})") from None
    return ("\n".join(out) + "\n").encode("utf-8")


def _parse_time(value: Optional[str]) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        at = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=datetime.timezone.utc)
    return at.timestamp()


def finished(batch: Batch, now: Optional[float] = None) -> bool:
    """Whether a batch's results can be collected: done or failed, or cancelled with every line accounted for (lines that
    were in progress when it was cancelled still come back, and are billed, before its results are ready). A cancelled
    batch whose counts never add up (its lines could not be read back) is taken as finished 10 minutes after the cancel."""
    if batch.status in ("done", "failed"):
        return True
    if batch.status != "cancelled":
        return False
    if batch.counts.done + batch.counts.failed >= batch.lines:
        return True
    at = _parse_time(batch.finished_at)
    return at is None or (time.time() if now is None else now) - at >= CANCEL_SETTLE_SECONDS


def _passing(e: Exception) -> bool:
    """An error that says nothing about the batch: the endpoint was briefly unreachable, busy or rate-limited."""
    if isinstance(e, (APIConnectionError, RateLimitError)):
        return True
    return isinstance(e, APIError) and e.type != "batch_unavailable"


def _seconds(name: str, value: Any, least: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < least:
        raise ValueError(f"{name} must be a number of seconds >= {least:g}")
    return float(value)


# -- the API ----------------------------------------------------------------


def _create_retryable(status: int, type_: Optional[str]) -> bool:
    # a submission is retried only when the server refused it without storing it, so a retry never makes two batches
    return (status == 429 and type_ == "rate_limited") or (status == 503 and type_ == "busy")


class Batches:
    """``client.batches``: the Batch API. Many decisions in one file, answered within 24 hours at half the live price."""

    def __init__(self, client: "Launchables") -> None:
        self._client = client

    def _json(self, method: str, path: str, **kw: Any) -> Dict[str, Any]:
        status, raw = self._client._send(method, path, key=self._client._resolve_key(), **kw)
        return self._client._decode(raw, status)

    def create(self, lines: Sequence[BatchLine], webhook_url: Optional[str] = None, *,
               idempotency_key: Optional[str] = None) -> CreatedBatch:
        """Submit a batch. Every line is checked here first (``ValidationError`` names the line), then the server checks
        every line again and refuses the whole batch if any is invalid (``InvalidRequestError`` with ``type``
        "invalid_batch" and the lines in ``body["errors"]``), so nothing is queued half-way.

        ``webhook_url`` is an https address to tell when the batch ends. It receives one POST of ``{"id", "status"}``,
        never results, and must resolve to public addresses only.

        The submission is retried only after a refusal that stored nothing (429 "rate_limited", 503 "busy"), never after
        a lost connection or a 502, so a retry cannot create two batches.

        Every submission carries an ``Idempotency-Key`` (``idempotency_key``, or a random one), the same on each retry.
        Pass your own and submit again with it after an error you are unsure about (a lost connection, a timeout): if
        the first submission was stored, no second batch is made and ``IdempotencyKeyAlreadyUsedError`` is raised, its
        ``batch_id`` naming the first batch (follow it with ``retrieve``). Lines need no key: each is identified by its
        ``custom_id``."""
        from .client import idempotency_headers  # the client imports this module

        idem = idempotency_headers(idempotency_key)
        body = to_jsonl(lines)
        if webhook_url is not None and (not isinstance(webhook_url, str) or not webhook_url.startswith("https://")):
            raise ValidationError("webhook_url must be an https address")
        headers = {**idem, **({"Launchables-Webhook-Url": webhook_url} if webhook_url else {})}
        data = self._json("POST", "/v1/batches", payload=body, content_type="application/jsonl", headers=headers,
                          once=_create_retryable)
        return parse_created_batch(data)

    def list(self) -> List[Batch]:
        """Every batch of the calling key, oldest first (until it is deleted)."""
        data = self._json("GET", "/v1/batches")
        rows = data.get("data")
        return [parse_batch(b) for b in rows if isinstance(b, dict)] if isinstance(rows, list) else []

    def retrieve(self, batch_id: str) -> Batch:
        """A batch's status and counts."""
        return parse_batch(self._json("GET", _batch_path(batch_id)))

    def cancel(self, batch_id: str) -> Batch:
        """Stop a batch. Lines already answered stay in the results and are billed; the rest read as cancelled and are not.
        Cancelling a cancelled batch is not an error; a batch already done or failed raises ``ConflictError`` (``type``
        "batch_finished")."""
        return parse_batch(self._json("POST", _batch_path(batch_id) + "/cancel"))

    def stream_results(self, batch_id: str) -> Iterator[BatchResult]:
        """Every result line, read as it arrives: one per input line, in input order. Use this for large batches, so the
        whole file is never held in memory. The client's ``timeout`` covers the wait for the response and then each read.
        Raises ``ConflictError`` (``type`` "batch_not_finished") until the batch has ended.

        Results can be downloaded once: they are deleted as soon as they have been sent in full, and results never
        downloaded are deleted 24 hours after the batch finished. After that this raises ``BatchResultsDeletedError``
        (410), so keep what you read."""
        path = _batch_path(batch_id) + "/results"
        resp = self._client._send("GET", path, key=self._client._resolve_key(), accept="application/jsonl", read=False)
        try:
            while True:
                try:
                    raw = resp.readline()
                except (OSError, socket.timeout, http.client.HTTPException) as e:
                    err = APIConnectionError(f"The results stream from {self._client.base_url} broke off: {e}")
                    raise err from e
                if not raw:
                    return
                if not raw.strip():
                    continue
                try:
                    data = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    raise LaunchablesError("Server returned a results line that is not JSON", 200, raw[:500]) from None
                if not isinstance(data, dict):
                    raise LaunchablesError("Server returned an unexpected results line", 200, data)
                yield parse_result(data)
        finally:
            resp.close()  # also stops the download if the caller left the loop early

    def results(self, batch_id: str) -> List[BatchResult]:
        """Every result line at once, in input order. For large batches prefer ``stream_results``. Results can be
        downloaded once (see ``stream_results``); a later call raises ``BatchResultsDeletedError``."""
        return list(self.stream_results(batch_id))

    def wait_for(
        self,
        batch_id: str,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        max_interval: float = DEFAULT_MAX_INTERVAL,
        timeout: float = DEFAULT_WAIT_TIMEOUT,
        on_poll: Optional[Callable[[Batch], None]] = None,
        stop: Optional[threading.Event] = None,
    ) -> Batch:
        """Polls the batch until it has ended and its results can be collected, and returns the final status.

        The first check is made at once. The wait after it is ``poll_interval`` seconds (default 5), 1.5 times longer
        after each check, up to ``max_interval`` (default 60); both must be at least 1 second. After ``timeout`` seconds
        (default 25 hours, past the 24-hour window) it raises ``BatchTimeoutError``; the deadline also shortens a status
        request in flight (each read of it, not the whole exchange). Setting ``stop`` (a ``threading.Event``) ends the wait
        with ``BatchWaitCancelledError``: at once during a wait, including the client's own retry waits, and after the
        current attempt (within the client's ``timeout``) when a status request is in flight.
        ``on_poll(batch)`` sees each status read.

        It keeps waiting through a brief outage (connection errors, 429 and 5xx other than "batch_unavailable"), and
        raises anything else. Giving up never cancels the batch."""
        path = _batch_path(batch_id)
        first = _seconds("poll_interval", poll_interval, 1)
        most = _seconds("max_interval", max_interval, 1)
        limit = _seconds("timeout", timeout, 0)
        if stop is not None and not callable(getattr(stop, "wait", None)):
            raise TypeError("stop must be a threading.Event")
        last: Optional[Batch] = None
        key = self._client._resolve_key()
        deadline = time.monotonic() + limit

        def stopped() -> LaunchablesError:
            if stop is not None and stop.is_set():
                return BatchWaitCancelledError(f"stopped waiting for batch {batch_id}", last)
            return BatchTimeoutError(
                f"batch {batch_id} is still {last.status if last else 'unknown'} after {limit:g} s", last
            )

        if stop is not None and stop.is_set():
            raise stopped()
        interval = min(first, most)
        from .client import _Interrupted  # the client imports this module

        while True:
            batch: Optional[Batch] = None
            try:
                status, raw = self._client._send("GET", path, key=key, deadline=deadline, stop=stop)
                batch = parse_batch(self._client._decode(raw, status))
            except _Interrupted:
                raise stopped() from None
            except LaunchablesError as e:
                if (stop is not None and stop.is_set()) or time.monotonic() >= deadline:
                    raise stopped() from None
                if not _passing(e):
                    raise
                # an outage longer than the client's own retries: keep waiting, the batch is unaffected
            if stop is not None and stop.is_set():
                raise stopped()
            if batch is not None:
                last = batch
                if on_poll is not None:
                    on_poll(batch)
                if finished(batch):
                    return batch
            left = deadline - time.monotonic()
            if left <= 0:
                raise stopped()
            pause = min(interval, left)
            if stop is not None:
                if stop.wait(pause):
                    raise stopped()
            else:
                self._client._pause(pause)
            interval = min(interval * 1.5, most)
