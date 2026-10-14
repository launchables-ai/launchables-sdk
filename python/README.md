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

`decide` returns a `DecisionResponse` with `.answers`, `.usage`, `.model` and `.raw` (the untouched JSON). `state` may be a string or a dict.

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

## Error handling

All errors derive from `LaunchablesError` and carry `.status` and `.message` (the server's message).

| Error | When |
| --- | --- |
| `AuthenticationError` | 401, or no key given or found |
| `RateLimitError` | 429 (`.retry_after` seconds, if sent) |
| `InvalidRequestError` | 400, 411, 413, 422 and other 4xx; `ValidationError` is the local pre-flight subclass |
| `APIError` | 5xx |
| `APIConnectionError` | could not reach the server (including timeouts) |

```python
from launchables import RateLimitError, InvalidRequestError, LaunchablesError

try:
    resp = client.decide(state, questions)
except RateLimitError as e:
    print("slow down", e.retry_after)
except InvalidRequestError as e:
    print(e.status, e.message)
except LaunchablesError as e:
    print("failed:", e)
```

## Retries

429, 502, 503 and connection errors are retried up to `max_retries` times (default 3) with exponential backoff of 0.5s, 1s, 2s. A `Retry-After` header (seconds) is honoured instead, capped at 60s. Other errors are raised immediately. `timeout` (seconds, default 30) applies to each attempt.

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
