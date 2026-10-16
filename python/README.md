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
)

answer = resp.answers["refund"]
print(answer.probability)                    # probability of yes, e.g. 0.04
print(answer.decide(threshold_yes=0.9, threshold_no=0.1))  # "yes" | "no" | "person"
print(resp.usage.input_tokens, resp.model)
```

`decide` returns a `DecisionResponse` with `.answers`, `.usage`, `.model` and `.raw` (the untouched JSON). `state` may be a string or a dict. To include images, see [Images](#images).

### Question types

```python
from launchables import noul, choice, score

questions = {
    "refund": noul("Is a refund permitted?", true="Policy clearly allows it", false="Policy clearly forbids it"),
    "topic": choice("What is this about?", ["billing", "returns", "other"]),       # or {label: description}
    "urgency": score("How urgent is it?", ["not urgent", "low", "medium", "high"]),  # lowest level first, numbered from 0
}
resp = client.decide(state, questions)

resp.answers["topic"].choice          # "returns"
resp.answers["topic"].probabilities   # {"billing": 0.06, "returns": 0.89, ...}
resp.answers["urgency"].level         # 2
resp.answers["urgency"].score         # 1.92
resp.answers["urgency"].probabilities # {"0": 0.03, "1": 0.12, ...}
```

Helpers validate locally and raise `ValidationError` before any request is sent: at most 16 questions per request, at most 26 options per choice, non-empty instructions.

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

All errors derive from `LaunchablesError` and carry `.status`, `.message` (the server's message), `.body` and `.type` (the server's error type, such as `"out_of_credit"`, or `None` if it sent none).

| Error | When |
| --- | --- |
| `AuthenticationError` | 401, or no key (or admin key) given or found |
| `OutOfCreditError` | 402: the account has run out of prepaid credit (`.type` `"out_of_credit"`, top up in the console), or the key's workspace has reached its monthly budget (`.type` `"budget_exceeded"`) |
| `PermissionDeniedError` | 403: the key's workspace may not use this model (`.type` `"model_not_allowed"`), or the admin key's maker is no longer an owner |
| `RateLimitError` | 429 (`.retry_after` seconds, if sent) |
| `InvalidRequestError` | 400, 411, 413, 422 and other 4xx; `ValidationError` is the local pre-flight subclass. `.type` says what was wrong with an image: `"invalid_assets"`, `"unsupported_image_format"`, `"invalid_image"`, `"image_too_large"`, `"image_dimensions"`, `"too_many_images"`, `"unreferenced_asset"` or `"image_reference_truncated"` (400), or `"invalid_image_budget"` (422). |
| `NotFoundError`, `ConflictError` | 404 and 409 from the key management API (subclasses of `InvalidRequestError`) |
| `APIError` | 5xx |
| `APIConnectionError` | could not reach the server (including timeouts) |

```python
from launchables import OutOfCreditError, RateLimitError, InvalidRequestError, LaunchablesError

try:
    resp = client.decide(state, questions)
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

## Self-hosted endpoints

```python
client = Launchables(base_url="https://decisions.internal.example.com")
```

Requests carry `User-Agent: launchables-python/<version>`.

## Tests

```
PYTHONPATH=src python -m unittest discover -s tests -t .
```
