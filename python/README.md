# launchables (Python)

Python client for the Launchables Decision API. Standard library only, Python 3.9+.

```
pip install launchables
```

## Quick start

```python
from launchables import Launchables, noul

client = Launchables()  # reads LAUNCHABLES_API_TOKEN

resp = client.decide(
    "Customer bought the item 12 days ago and has no receipt. "
    "Policy: refunds within 30 days with proof of purchase.",
    {"refund": noul("Is a refund permitted under the policy?")},
    model="myles-g-12b",
)

answer = resp.answers["refund"]
print(answer.probability)                    # probability of yes, e.g. 0.04
print(answer.decide(threshold_yes=0.9, threshold_no=0.1))  # "yes" | "no" | "person"
print(resp.usage.input_tokens, resp.model)
```

`decide(state, questions, model=...)` returns a `DecisionResponse` with `.answers`, `.usage`, `.model` and `.raw` (the untouched JSON). `state` may be a string or a dict. To include images, see [Images](#images).

Always pass `model`, a model id from `client.models()` (for example `"myles-g-12b"` or `"myles-g-31b"`), so every request names the model that answers it. The API is moving to requiring it; until then a request without one is answered by the server's default model, which can change.

### Question types

```python
from launchables import noul, choice, score

questions = {
    "refund": noul("Is a refund permitted?", true="Policy clearly allows it", false="Policy clearly forbids it"),
    "topic": choice("What is this about?", ["billing", "returns", "other"]),       # or {label: description}
    "urgency": score("How urgent is it?", ["not urgent", "low", "medium", "high"]),  # lowest level first, numbered from 0
}
resp = client.decide(state, questions, model="myles-g-12b")

resp.answers["topic"].choice          # "returns"
resp.answers["topic"].probabilities   # {"billing": 0.06, "returns": 0.89, ...}
resp.answers["urgency"].level         # 2
resp.answers["urgency"].score         # 1.92
resp.answers["urgency"].probabilities # {"0": 0.03, "1": 0.12, ...}
```

Helpers validate locally and raise `ValidationError` before any request is sent: at most 256 questions per request, at most 256 options per choice and 4,096 options over a request (the API's largest limits; Myles-G 31B takes 16 and 26 for now and answers 422 above them), non-empty instructions.

### Other calls

```python
client.models()   # [Model(id="myles-g-12b", ...)]
client.health()   # {"status": "ok"}
```

`models()` and `health()` need no token.

## Images

Pass images in `assets`, keyed by a reference of your choosing, and write that reference wherever the model should see the image: in the state (a text state, or any string value in a JSON state), a question's instructions, or a criterion's description. Option labels are not searched.

```python
from launchables import Image, Launchables, noul

client = Launchables()

resp = client.decide(
    {"receipt": "receipt_photo", "note": "Customer asks for a refund"},
    {"total_matches": noul("Does the total printed on receipt_photo equal 23.40?")},
    assets={"receipt_photo": Image.from_path("receipt.jpg")},
    model="myles-g-12b",
    image_budget=140,  # optional: 70, 140 or 280 (the default)
)
```

`Image.from_path(path)` and `Image.from_bytes(data)` detect PNG or JPEG from the file's first bytes; pass `format="png"`, `"jpg"` or `"jpeg"` to state it (it must match the bytes). A plain dict in the wire shape, `{"type": "image", "format": "jpeg", "data_base64": "..."}`, is accepted as it is. References are matched as plain, case-sensitive text; every place a reference appears shows the image there, and when one reference contains another the longer one wins.

`image_budget` is the most visual tokens one image may use. Lower is cheaper and faster but sees less detail (small print suffers first). Any value other than 70, 140 or 280 raises `ValidationError` before sending; leave it out to get the server default of 280.

Limits, checked by the server (each breach is an `InvalidRequestError` whose message names the asset):

- PNG or JPEG only, still images, and the bytes must match the format. The helper detects the format from the bytes and refuses anything else before sending.
- At most 16 MiB per image (the helper checks this too). Width and height each from 280 to 1568 pixels. Images are never resized or re-encoded, by the client or the server, so resize larger images yourself first.
- At most 8 assets per request, and at most 8 images shown in any one question (each use of a reference counts).
- Every asset must be referenced at least once. A reference inside a text state must fall within its first 20,000 characters.

Images count as input tokens and are included in `usage.input_tokens`. At budget 280 one image costs up to about 280 tokens, at 140 up to about 140, at 70 up to about 70. An image referenced in the state is billed once per request however many questions read it; one referenced in a question's instructions or criteria is billed for that question, once per use.

## Batches

The Batch API answers many decisions from one submission, within 24 hours, at half the live price per input token. Use it for work that does not need an answer straight away: back-catalogues, nightly reviews, re-scoring after a policy change. Batch support is in version 0.5.0 and later.

```python
from launchables import Launchables, choice, noul

client = Launchables()

batch = client.batch([
    {"custom_id": "ticket-1001", "model": "myles-g-12b", "state": "Charged twice for order 4471",
     "questions": {"refund": noul("Is a refund due?")}},
    {"custom_id": "ticket-1002", "model": "myles-g-31b", "state": {"message": "The app crashes on login"},
     "questions": {"team": choice("Which team?", ["billing", "returns", "technical", "other"])}},
])  # CreatedBatch(id="batch_...", status="queued", lines=2, estimated_cost=..., expires_at=..., data_region=...)

finished = client.batches.wait_for(batch.id)  # polls 5 s, 7.5 s, 11.25 s ... up to 60 s apart

for r in client.batches.stream_results(batch.id):
    if r.ok:
        print(r.custom_id, r.response.answers)  # a DecisionResponse, exactly as decide() returns it
    else:
        print(r.custom_id, r.error.get("type"))  # e.g. "expired", "cancelled", "invalid_question"
```

Each line is a dict: the body of one `decide` request with your own `custom_id` (1 to 64 letters, digits or `_ . : -`, unique in the batch) and a `model`, which every line must name: a batch has no default model. Keys are as they are sent: `custom_id`, `model`, `state`, `questions`, and optionally `assets` and `image_budget`. Lines may name different models. Images must be inline (`Image.from_path`, `Image.from_bytes`, or a dict with `data_base64`); a batch line cannot carry file parts.

| Call | What it does |
| --- | --- |
| `batch(lines, webhook_url=None)` or `batches.create(...)` | Checks every line, sends them as one JSONL file and returns the queued batch (`CreatedBatch`) with its cost estimate. |
| `batches.list()` | The calling key's batches (`Batch`), oldest first. |
| `batches.retrieve(batch_id)` | Status (`"queued"`, `"running"`, `"done"`, `"failed"` or `"cancelled"`), `counts` (`done`, `failed`, `pending`) and times. |
| `batches.wait_for(batch_id, ...)` | Polls until the results can be collected. The first check is at once; the wait after it, `poll_interval` (5 seconds), grows 1.5 times a check up to `max_interval` (60 seconds), both at least 1 second; `timeout` (25 hours) raises `BatchTimeoutError`; setting `stop` (a `threading.Event`) raises `BatchWaitCancelledError`; `on_poll(batch)` sees each status. It keeps waiting through a brief outage (connection errors, 429 and 5xx other than `batch_unavailable`). Giving up never cancels the batch. |
| `batches.stream_results(batch_id)` | Each result line as it arrives, in input order, so a large file is never held in memory. |
| `batches.results(batch_id)` | Every result line in one list. |
| `batches.cancel(batch_id)` | Stops the batch. Lines already answered stay in the results and are billed; the rest read as cancelled and are not. |

A result is an `AnsweredBatchResult` (`ok` is `True`, `response` is a `DecisionResponse`) or a `FailedBatchResult` (`ok` is `False`, `error` is a dict saying why). Both have `custom_id`, `model` (the exact model build that answered), `status` (the HTTP status the line got, 200 when answered, or `None` for a line that never ran), `usage` (`input_tokens` is what the line is billed on) and `raw`. `BatchTimeoutError` and `BatchWaitCancelledError` carry the last status read in `.batch`.

The client checks every line before sending and raises `ValidationError` naming the line (`line 3 (custom_id ticket-1003): ...`). The server checks every line again and refuses the whole batch if any is invalid: `InvalidRequestError` with `.type` `"invalid_batch"` and each bad line in `e.body["errors"]` (`{"line", "type", "error"}`), so nothing is half-queued. Other batch errors: `RateLimitError` with `.type` `"too_many_batches"` when the key already has its limit of batches queued or running (not retried; `.retry_after` says when to try); `ConflictError` with `.type` `"batch_not_finished"` for results before the batch has ended, or `"batch_finished"` for cancelling a batch that is already done or failed; `NotFoundError` (`"batch_not_found"`) for an id the key does not own; `APIError` with `.type` `"batch_unavailable"` where the Batch API is not switched on (not retried).

A submission is retried only after a refusal that stored nothing (429 `rate_limited`, 503 `busy`), never after a lost connection or a 502, so a retry cannot submit the same batch twice. After such an error, submit again with the same `idempotency_key` (pass your own): if the first submission was stored, no second batch is made and `IdempotencyKeyAlreadyUsedError` is raised, its `.batch_id` naming the first batch, so you can follow it with `batches.retrieve`. Lines need no key; each is identified by its `custom_id`. Status, results and cancel calls are retried like any other.

Results can be downloaded once. They are deleted as soon as they have been sent to you in full, and results that are never downloaded are deleted 24 hours after the batch finished. After that, `results` and `stream_results` raises `BatchResultsDeletedError` (410, `.type` `"batch_results_deleted"`, `.results_deleted_at` says when), so save the results as you read them. A batch's status shows `results_deleted_at` once they are gone.

Batches belong to the API key that submitted them. A rolled key is a new key: collect a batch's results with the key that submitted it, before that key stops working. See the [Batch API documentation](https://www.launchables.ai/docs/api/batches) for limits, the 24-hour window, webhooks, retention and where batch data is stored.

## Key expiry

Every API key expires. The client reads the expiry date from each response, so your program can plan rotation instead of finding out when the key stops working.

```python
def on_expiry(expiry):
    # called once per key and expiry date when 14 days or fewer are left: alert your team, or start a rotation job
    alert_team(f"Launchables key {expiry.key_id} expires on {expiry.expires_on} ({expiry.days_left} days left)")

client = Launchables(on_key_expiry=on_expiry)

client.key()
# KeyInfo(id="c_1a2b3c4d", name="prod", expires_on="2027-01-13", days_left=89, workspace=None,
#         rate_limit_per_minute=600, daily_limit=10000000, paused=False, pause_reason=None)

client.key_expiry  # KeyExpiry(key_id, expires_on, days_left) from the last response, or None
```

Without `on_key_expiry`, the client issues one `KeyExpiryWarning` when 14 days or fewer are left. `key()` counts as no request and no tokens, and works for a paused key so you can see why it is paused (`pause_reason`). The expiry headers add nothing to your token count. To replace a key without downtime, roll it on the API keys page of the console: the old key keeps working until the end of the next day.

## Managing keys

To rotate keys from your own scripts, use an admin key. An owner makes one on the API keys page of the console (two-step sign-in must be on). Admin keys start with `launchables_admin_`, always expire, and can only manage your organisation's API keys: they cannot call the Decision API.

```python
client = Launchables(admin_key=os.environ["LAUNCHABLES_ADMIN_KEY"])  # or just set LAUNCHABLES_ADMIN_KEY

page = client.admin.keys.list()  # {"data": [{"id", "name", "prefix", "workspace", "expires_on", "last_used_on", "status", ...}], "has_more", "next_before"}
for key in client.admin.keys.list_all():
    print(key["id"], key["status"])

made = client.admin.keys.create("staging", expires_in_days=90)  # workspace_id is optional
made["key"]  # the full key, shown only this once

rolled = client.admin.keys.roll("c_1a2b3c4d")
rolled["key"]  # the new key; rolled["replaces"]["expires_on"] is when the old one stops (the end of tomorrow)

client.admin.keys.revoke("c_1a2b3c4d")
```

Key lifetimes are 30, 90, 180 or 365 days (90 by default), never longer than your organisation allows. These calls go to `https://console.launchables.ai` (`admin_base_url` to change it) and may be made 120 times a minute per admin key. A missing key or workspace raises `NotFoundError` (404); the key limit or an archived workspace raises `ConflictError` (409); both are kinds of `InvalidRequestError`. `create` and `roll` are retried only after a 429, so a retry never makes a second key. Every change shows in Activity in the console.

## Error handling

All errors derive from `LaunchablesError` and carry `.status`, `.message` (the server's message), `.body` and `.type` (the server's error type, such as `"out_of_credit"`, or `None` if it sent none). `IdempotencyKeyAlreadyUsedError` and `BatchResultsDeletedError` put the client's explanation of what to do in `.message` and keep the server's in `.server_message`.

| Error | When |
| --- | --- |
| `AuthenticationError` | 401, or no key (or admin key) given or found |
| `OutOfCreditError` | 402: the account has run out of prepaid credit (`.type` `"out_of_credit"`, top up in the console), or the key's workspace has reached its monthly budget (`.type` `"budget_exceeded"`) |
| `PermissionDeniedError` | 403: the key's workspace may not use this model (`.type` `"model_not_allowed"`), or the admin key's maker is no longer an owner |
| `RateLimitError` | 429 (`.retry_after` seconds, if sent) |
| `InvalidRequestError` | 400, 411, 413, 422 and other 4xx; `ValidationError` is the local pre-flight subclass. `.type` says what was wrong with an image: `"invalid_assets"`, `"unsupported_image_format"`, `"invalid_image"`, `"image_too_large"`, `"image_dimensions"`, `"too_many_images"`, `"unreferenced_asset"` or `"image_reference_truncated"` (400), or `"invalid_image_budget"` (422). |
| `NotFoundError`, `ConflictError` | 404 and 409 from the key management API and the Batch API (subclasses of `InvalidRequestError`) |
| `IdempotencyKeyAlreadyUsedError` | 409 `"idempotency_key_already_used"`: a request with this `Idempotency-Key` was already answered. Never retried. `.request_id` names the answered request and `.batch_id` the batch a submission created. A subclass of `ConflictError` (see Retries) |
| `BatchResultsDeletedError` | 410 `"batch_results_deleted"`: the batch's results were already downloaded once, or were never downloaded within 24 hours of the batch finishing. A subclass of `InvalidRequestError` |
| `APIError` | 5xx |
| `APIConnectionError` | could not reach the server (including timeouts) |

```python
from launchables import OutOfCreditError, RateLimitError, InvalidRequestError, LaunchablesError

try:
    resp = client.decide(state, questions, model="myles-g-12b")
except OutOfCreditError as e:
    print("workspace budget reached" if e.type == "budget_exceeded" else "top up credit")
except RateLimitError as e:
    print("slow down", e.retry_after)
except InvalidRequestError as e:
    print(e.status, e.message)
except LaunchablesError as e:
    print("failed:", e)
```

## Retries

429, 502, 503 and connection errors are retried up to `max_retries` times (default 3) with exponential backoff of 0.5s, 1s, 2s. A `Retry-After` header (seconds) is honoured instead, capped at 60s. Other errors, including 402 and 403, are raised immediately. `timeout` (seconds, default 30) applies to each attempt.

```python
client = Launchables(api_key="launchables_...", timeout=10, max_retries=5)
```

### Retries are never billed twice

Every `decide` call and batch submission carries an `Idempotency-Key` header: a random UUID made for that call, sent again unchanged on each of its retries, so a request is never answered and billed twice. The API keeps no copy of a live answer once it has been sent (it remembers only that the key was used), so it cannot send that answer again. If an earlier attempt was answered but the answer never reached you (a timeout or a dropped connection), the retry is refused with 409 `idempotency_key_already_used` and the client raises `IdempotencyKeyAlreadyUsedError`, with `.request_id` naming the request that was answered (and, for a batch submission, `.batch_id`). It is not retried, and the refused repeat is not billed and does not count towards your rate or daily limits. If you need the answer, send the request again with a new key: it is then answered, and billed, as a new request. Keys are remembered for 24 hours after a successful answer; failed attempts are not remembered, so they are retried as new requests.

Pass your own key to make a request safe to repeat across restarts of your program, for example a job or order id. Use a new key for each new request: the same key with a different request raises `InvalidRequestError` with `.type` `"idempotency_key_reused"`.

```python
r = client.decide(state, questions, model="myles-g-12b", idempotency_key="order-4471-refund-check")
batch = client.batch(lines, idempotency_key="nightly-2026-10-25")
```

A key is 1 to 255 printable ASCII characters (anything else raises `ValidationError` before sending). While an earlier attempt with the same key is still being answered, the API answers 409 `idempotency_in_progress`; the client waits (honouring `Retry-After`) for up to 150 seconds in all, without using up `max_retries`, and asks again. If the first attempt was answered meanwhile, that repeat is refused as above (`IdempotencyKeyAlreadyUsedError`). If it is still not finished after 150 seconds, `ConflictError` is raised and you can call again with the same key later.

```python
from launchables import IdempotencyKeyAlreadyUsedError

try:
    r = client.decide(state, questions, model="myles-g-12b", idempotency_key=job.key)
except IdempotencyKeyAlreadyUsedError as e:
    # answered before (e.request_id) but the answer was lost; ask again under a new key (billed again)
    r = client.decide(state, questions, model="myles-g-12b", idempotency_key=job.key + "-retry")
```

## Self-hosted endpoints

```python
client = Launchables(base_url="https://decisions.internal.example.com")
```

Requests carry `User-Agent: launchables-python/<version>`.

## Tests

```
PYTHONPATH=src python -m unittest discover -s tests -t .
```
